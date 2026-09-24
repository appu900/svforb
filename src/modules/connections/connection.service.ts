import {
  BadRequestException, ConflictException, ForbiddenException, Injectable,
  Logger, NotFoundException,
} from '@nestjs/common';
import {
  ConnectionDayOutcome, ConnectionFrequency, ConnectionInitiator,
  ConnectionStatus, ListingStatus, OrgRole, OrgType, Prisma, SiteRole,
} from '@prisma/client';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { Jwtpayload } from '../auth/interface/jwt.interface';
import { ConnectionNotifier } from './connection.notifier';
import {
  assertDistinctSites, assertTransition, CONNECTION_ERROR, isCollecting,
  LIVE_STATUSES, releaseReasonFor, reliabilityFrom, ReleaseTrigger,
} from './connection.rules';
import {
  assertValidTimezone, describeSchedule, parseLocalTime, resolveDay,
  schedulesOverlap, validateSchedule,
} from './connection.schedule';
import {
  AddDailySurplusDto, CreateConnectionDto, UpdateConnectionDto,
} from './dto/connection.dto';

const CHARITY_TYPES: OrgType[] = [OrgType.CHARITY_SINGLE, OrgType.CHARITY_MULTI];
const INVITATION_TTL_DAYS = 7;

@Injectable()
export class ConnectionService {
  private readonly logger = new Logger(ConnectionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifier: ConnectionNotifier,
  ) {}

  // ─── Setup ─────────────────────────────────────────────────────────────────

  /**
   * The business invites a charity. Nothing is listed and no food is created —
   * this establishes the relationship only.
   */
  async invite(caller: Jwtpayload, dto: CreateConnectionDto) {
    assertDistinctSites(dto.donorSiteId, dto.receiverSiteId);
    await this.assertSiteAdmin(caller, dto.donorSiteId);

    const donorSite = await this.prisma.site.findUnique({
      where: { id: dto.donorSiteId },
      select: { id: true, organisationId: true, timezone: true, name: true, organisationName: true },
    });
    if (!donorSite) throw new NotFoundException('Site not found');

    // A wall-clock schedule is meaningless without a zone to resolve it in,
    // and guessing would fire prompts hours early or late.
    if (!donorSite.timezone) {
      throw new BadRequestException({
        error: CONNECTION_ERROR.SITE_TIMEZONE_MISSING,
        message:
          'Set this site’s timezone before scheduling collections, so the pickup window means the right hour locally.',
        siteId: donorSite.id,
      });
    }
    assertValidTimezone(donorSite.timezone);

    const receiverSite = await this.prisma.site.findUnique({
      where: { id: dto.receiverSiteId },
      select: { id: true, organisationId: true, name: true, organisationName: true },
    });
    if (!receiverSite) throw new NotFoundException('Charity site not found');

    // Site.organisationId carries no foreign key in this schema, so the
    // organisation is read separately rather than through a relation.
    const receiverOrg = await this.prisma.organisation.findUnique({
      where: { id: receiverSite.organisationId },
      select: { id: true, name: true, organizationType: true },
    });
    if (!receiverOrg) throw new NotFoundException('Charity organisation not found');
    if (!CHARITY_TYPES.includes(receiverOrg.organizationType)) {
      throw new BadRequestException({
        error: CONNECTION_ERROR.NOT_A_CHARITY,
        message: 'Regular collections can only be set up with a charity.',
      });
    }

    const windowStartMinutes = parseLocalTime(dto.windowStart);
    const windowEndMinutes = parseLocalTime(dto.windowEnd);
    const leadTimeMinutes = dto.leadTimeMinutes ?? 60;
    const cutoffMinutes = dto.cutoffMinutes ?? 30;

    validateSchedule({
      daysOfWeek: dto.daysOfWeek, windowStartMinutes, windowEndMinutes,
      leadTimeMinutes, cutoffMinutes,
    });

    // One live relationship per pair of sites; ended ones stay as history.
    const existing = await this.prisma.connection.findFirst({
      where: {
        donorSiteId: dto.donorSiteId,
        receiverSiteId: dto.receiverSiteId,
        status: { in: [...LIVE_STATUSES] },
      },
      select: { id: true, status: true },
    });
    if (existing) {
      throw new ConflictException({
        error: CONNECTION_ERROR.CONNECTION_EXISTS,
        message: `This site already has a ${existing.status.toLowerCase()} connection with that charity.`,
        connectionId: existing.id,
      });
    }

    // A site may hold many Connections. Two charities due in the same window
    // on the same day is legal but ambiguous — the kitchen is prompted twice
    // for one pile of food — so it is flagged rather than refused.
    const siblings = await this.prisma.connection.findMany({
      where: {
        donorSiteId: donorSite.id,
        status: { in: [ConnectionStatus.ACTIVE, ConnectionStatus.PENDING] },
      },
      include: { receiverSite: { select: { name: true, organisationName: true } } },
    });

    const clashes = siblings
      .filter((sib) =>
        schedulesOverlap(
          { daysOfWeek: dto.daysOfWeek, windowStartMinutes, windowEndMinutes },
          sib,
        ),
      )
      .map((sib) => ({
        connectionId: sib.id,
        charity: sib.receiverSite.name ?? sib.receiverSite.organisationName,
        schedule: describeSchedule(
          sib.daysOfWeek, sib.windowStartMinutes, sib.windowEndMinutes,
        ),
      }));

    const connection = await this.prisma.connection.create({
      data: {
        donorSiteId: donorSite.id,
        donorOrgId: donorSite.organisationId,
        receiverSiteId: receiverSite.id,
        receiverOrgId: receiverSite.organisationId,
        status: ConnectionStatus.PENDING,
        initiatedBy: ConnectionInitiator.BUSINESS,
        frequency: this.frequencyFor(dto.daysOfWeek),
        daysOfWeek: [...dto.daysOfWeek].sort((a, b) => a - b),
        windowStartMinutes, windowEndMinutes, leadTimeMinutes, cutoffMinutes,
        typicalSurplus: dto.typicalSurplus ?? null,
        notes: dto.notes ?? null,
        invitedByUserId: caller.sub,
        invitationExpiresAt: new Date(Date.now() + INVITATION_TTL_DAYS * 864e5),
      },
      include: {
        donorSite: { select: { name: true, organisationName: true } },
        donorOrg: { select: { name: true } },
      },
    });

    await this.notifier.invitationSent(connection);
    this.logger.log(
      `Connection invited: id=${connection.id} donorSite=${donorSite.id} ` +
        `charitySite=${receiverSite.id}${clashes.length ? ` (overlaps ${clashes.length})` : ''}`,
    );

    return {
      ...this.shape(connection),
      /** Existing connections on this site due in the same window. */
      scheduleClashes: clashes,
      ...(clashes.length
        ? {
            warning:
              `This site already has ${clashes.length} collection(s) scheduled in the same window. ` +
              'Staff will be asked for surplus more than once that day.',
          }
        : {}),
    };
  }

  /** The charity accepts. Collections begin from the next scheduled day. */
  async accept(caller: Jwtpayload, connectionId: number) {
    const connection = await this.requireConnection(connectionId);
    await this.assertCharitySide(caller, connection);
    assertTransition(connection.status, ConnectionStatus.ACTIVE);

    const updated = await this.prisma.connection.update({
      where: { id: connectionId },
      data: {
        status: ConnectionStatus.ACTIVE,
        respondedByUserId: caller.sub,
        respondedAt: new Date(),
      },
      include: { receiverSite: { select: { name: true, organisationName: true } } },
    });

    await this.notifier.invitationAnswered(updated, true);
    this.logger.log(`Connection accepted: id=${connectionId} by=${caller.sub}`);
    return this.shape(updated);
  }

  async decline(caller: Jwtpayload, connectionId: number) {
    const connection = await this.requireConnection(connectionId);
    await this.assertCharitySide(caller, connection);
    assertTransition(connection.status, ConnectionStatus.DECLINED);

    const updated = await this.prisma.connection.update({
      where: { id: connectionId },
      data: {
        status: ConnectionStatus.DECLINED,
        respondedByUserId: caller.sub,
        respondedAt: new Date(),
      },
      include: { receiverSite: { select: { name: true, organisationName: true } } },
    });

    await this.notifier.invitationAnswered(updated, false);
    return this.shape(updated);
  }

  /** Holidays and closures — the schedule and its history survive. */
  async pause(caller: Jwtpayload, connectionId: number) {
    return this.setStatus(caller, connectionId, ConnectionStatus.PAUSED);
  }

  async resume(caller: Jwtpayload, connectionId: number) {
    return this.setStatus(caller, connectionId, ConnectionStatus.ACTIVE);
  }

  async end(caller: Jwtpayload, connectionId: number) {
    return this.setStatus(caller, connectionId, ConnectionStatus.ENDED);
  }

  private async setStatus(
    caller: Jwtpayload,
    connectionId: number,
    status: ConnectionStatus,
  ) {
    const connection = await this.requireConnection(connectionId);
    await this.assertEitherSide(caller, connection);
    assertTransition(connection.status, status);

    const updated = await this.prisma.connection.update({
      where: { id: connectionId },
      data: {
        status,
        ...(status === ConnectionStatus.PAUSED ? { pausedAt: new Date() } : {}),
        ...(status === ConnectionStatus.ACTIVE ? { pausedAt: null } : {}),
        ...(status === ConnectionStatus.ENDED
          ? { endedAt: new Date(), endedByUserId: caller.sub }
          : {}),
      },
    });
    this.logger.log(`Connection ${connectionId} -> ${status} by=${caller.sub}`);
    return this.shape(updated);
  }

  /**
   * Changing the agreed terms returns the Connection to PENDING: the charity
   * committed to specific days and a specific hour, and must agree again.
   * Listings already published are untouched.
   */
  async update(caller: Jwtpayload, connectionId: number, dto: UpdateConnectionDto) {
    const connection = await this.requireConnection(connectionId);
    await this.assertSiteAdmin(caller, connection.donorSiteId);

    if (connection.status === ConnectionStatus.ENDED) {
      throw new ConflictException('This connection has ended and cannot be edited.');
    }

    const windowStartMinutes = dto.windowStart
      ? parseLocalTime(dto.windowStart) : connection.windowStartMinutes;
    const windowEndMinutes = dto.windowEnd
      ? parseLocalTime(dto.windowEnd) : connection.windowEndMinutes;
    const daysOfWeek = dto.daysOfWeek ?? connection.daysOfWeek;
    const leadTimeMinutes = dto.leadTimeMinutes ?? connection.leadTimeMinutes;
    const cutoffMinutes = dto.cutoffMinutes ?? connection.cutoffMinutes;

    validateSchedule({
      daysOfWeek, windowStartMinutes, windowEndMinutes, leadTimeMinutes, cutoffMinutes,
    });

    const termsChanged =
      windowStartMinutes !== connection.windowStartMinutes ||
      windowEndMinutes !== connection.windowEndMinutes ||
      JSON.stringify([...daysOfWeek].sort()) !==
        JSON.stringify([...connection.daysOfWeek].sort());

    const updated = await this.prisma.connection.update({
      where: { id: connectionId },
      data: {
        daysOfWeek: [...daysOfWeek].sort((a, b) => a - b),
        frequency: this.frequencyFor(daysOfWeek),
        windowStartMinutes, windowEndMinutes, leadTimeMinutes, cutoffMinutes,
        ...(dto.typicalSurplus !== undefined ? { typicalSurplus: dto.typicalSurplus } : {}),
        ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
        ...(termsChanged && connection.status === ConnectionStatus.ACTIVE
          ? {
              status: ConnectionStatus.PENDING,
              respondedAt: null,
              respondedByUserId: null,
              invitationExpiresAt: new Date(Date.now() + INVITATION_TTL_DAYS * 864e5),
            }
          : {}),
      },
      include: {
        donorSite: { select: { name: true, organisationName: true } },
        donorOrg: { select: { name: true } },
      },
    });

    if (termsChanged && updated.status === ConnectionStatus.PENDING) {
      await this.notifier.invitationSent(updated);
    }
    return { ...this.shape(updated), requiresReacceptance: termsChanged };
  }

  // ─── Reading ───────────────────────────────────────────────────────────────

  /** Connections for one business site. */
  async listForSite(caller: Jwtpayload, siteId: number) {
    await this.assertSiteMember(caller, siteId);
    const rows = await this.prisma.connection.findMany({
      where: { donorSiteId: siteId },
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
      include: {
        receiverSite: { select: { id: true, name: true, organisationName: true } },
        receiverOrg: { select: { id: true, name: true } },
      },
    });
    return Promise.all(rows.map((r) => this.withStats(r)));
  }

  /** The charity's side of the relationship. */
  async listForCharity(caller: Jwtpayload) {
    if (!caller.orgId) throw new ForbiddenException('Not part of an organisation');
    const rows = await this.prisma.connection.findMany({
      where: { receiverOrgId: caller.orgId },
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
      include: {
        donorSite: { select: { id: true, name: true, organisationName: true } },
        donorOrg: { select: { id: true, name: true } },
      },
    });
    return Promise.all(rows.map((r) => this.withStats(r)));
  }

  async getOne(caller: Jwtpayload, connectionId: number) {
    const connection = await this.requireConnection(connectionId);
    await this.assertEitherSide(caller, connection);
    const full = await this.prisma.connection.findUniqueOrThrow({
      where: { id: connectionId },
      include: {
        donorSite: { select: { id: true, name: true, organisationName: true, timezone: true } },
        donorOrg: { select: { id: true, name: true } },
        receiverSite: { select: { id: true, name: true, organisationName: true } },
        receiverOrg: { select: { id: true, name: true } },
      },
    });
    return this.withStats(full);
  }

  /**
   * Running totals for the Connection card: collections, weight, reliability.
   * Computed from the day ledger rather than stored, so a correction to a
   * claim is reflected without a backfill.
   */
  private async withStats(connection: any) {
    const [grouped, collectedKg] = await Promise.all([
      this.prisma.connectionDay.groupBy({
        by: ['outcome'],
        where: { connectionId: connection.id },
        _count: { _all: true },
      }),
      this.prisma.connectionDay.aggregate({
        where: { connectionId: connection.id, outcome: ConnectionDayOutcome.COLLECTED },
        _sum: { collectedKg: true },
      }),
    ]);

    const count = (o: ConnectionDayOutcome) =>
      grouped.find((g) => g.outcome === o)?._count._all ?? 0;

    const reliability = reliabilityFrom({
      collected: count(ConnectionDayOutcome.COLLECTED),
      released: count(ConnectionDayOutcome.RELEASED),
      missed: count(ConnectionDayOutcome.MISSED),
      noSurplus: count(ConnectionDayOutcome.NO_SURPLUS),
    });

    return {
      ...this.shape(connection),
      donorSite: connection.donorSite,
      donorOrg: connection.donorOrg,
      receiverSite: connection.receiverSite,
      receiverOrg: connection.receiverOrg,
      stats: {
        collectionsCompleted: reliability.collected,
        kgRedirected: Math.round((collectedKg._sum.collectedKg ?? 0) * 10) / 10,
        daysOffered: reliability.offered,
        declined: reliability.declined,
        missed: reliability.missed,
        noSurplusDays: count(ConnectionDayOutcome.NO_SURPLUS),
        reliabilityPercent: reliability.percent,
      },
    };
  }

  // ─── Guards ────────────────────────────────────────────────────────────────

  private async requireConnection(id: number) {
    const connection = await this.prisma.connection.findUnique({ where: { id } });
    if (!connection) throw new NotFoundException('Connection not found');
    return connection;
  }

  /** Any member of the site's organisation may read. */
  private async assertSiteMember(caller: Jwtpayload, siteId: number) {
    const site = await this.prisma.site.findUnique({
      where: { id: siteId }, select: { organisationId: true },
    });
    if (!site) throw new NotFoundException('Site not found');
    if (site.organisationId !== caller.orgId) {
      throw new ForbiddenException('That site belongs to another organisation.');
    }
  }

  /**
   * Setting up a standing relationship is an admin act: a site admin for that
   * site, or an organisation admin above it.
   */
  private async assertSiteAdmin(caller: Jwtpayload, siteId: number) {
    await this.assertSiteMember(caller, siteId);
    if (caller.orgRole === OrgRole.SUPER_ADMIN) return;

    const access = await this.prisma.siteAccess.findFirst({
      where: { userId: caller.sub, siteId, siteRole: SiteRole.SITE_ADMIN },
      select: { id: true },
    });
    if (!access) {
      throw new ForbiddenException(
        'Only a site admin or organisation admin can manage regular collections.',
      );
    }
  }

  /** Accepting commits vans and volunteers — not a volunteer's decision. */
  private async assertCharitySide(caller: Jwtpayload, connection: { receiverOrgId: number; receiverSiteId: number }) {
    if (caller.orgId !== connection.receiverOrgId) {
      throw new ForbiddenException('This invitation belongs to another organisation.');
    }
    if (caller.orgRole === OrgRole.SUPER_ADMIN) return;

    const access = await this.prisma.siteAccess.findFirst({
      where: { userId: caller.sub, siteId: connection.receiverSiteId, siteRole: SiteRole.SITE_ADMIN },
      select: { id: true },
    });
    if (!access) {
      throw new ForbiddenException(
        'Only a site admin or organisation admin can answer a regular collection invitation.',
      );
    }
  }

  private async assertEitherSide(
    caller: Jwtpayload,
    connection: { donorOrgId: number; receiverOrgId: number },
  ) {
    if (caller.orgId === connection.donorOrgId || caller.orgId === connection.receiverOrgId) return;
    throw new ForbiddenException('This connection belongs to another organisation.');
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private frequencyFor(days: number[]): ConnectionFrequency {
    if (days.length === 7) return ConnectionFrequency.DAILY;
    if (days.length === 1) return ConnectionFrequency.WEEKLY;
    return ConnectionFrequency.SELECT_DAYS;
  }

  private shape(connection: any) {
    return {
      id: connection.id,
      status: connection.status,
      initiatedBy: connection.initiatedBy,
      frequency: connection.frequency,
      daysOfWeek: connection.daysOfWeek,
      schedule: describeSchedule(
        connection.daysOfWeek, connection.windowStartMinutes, connection.windowEndMinutes,
      ),
      leadTimeMinutes: connection.leadTimeMinutes,
      cutoffMinutes: connection.cutoffMinutes,
      typicalSurplus: connection.typicalSurplus,
      notes: connection.notes,
      respondedAt: connection.respondedAt,
      pausedAt: connection.pausedAt,
      endedAt: connection.endedAt,
      invitationExpiresAt: connection.invitationExpiresAt,
      createdAt: connection.createdAt,
      isCollecting: isCollecting(connection.status),
    };
  }
}
