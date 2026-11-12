import {
  BadRequestException, ConflictException, Injectable, NotFoundException,
} from '@nestjs/common';
import {
  ConsolidatedCollectionStatus, ConsolidatedMemberRole, ConsolidatedScheduleStatus,
  ConsolidatedSiteInvitationStatus, OrgRole, Prisma, SiteRole,
} from '@prisma/client';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { Jwtpayload } from '../../auth/interface/jwt.interface';
import { assertValidTimezone, resolveDonorTimezone } from '../../connections/connection.schedule';
import { CONSOLIDATED_ERROR } from '../consolidated.errors';
import {
  CreateGroupDto, GroupListQueryDto, SetGroupMembersDto, SetGroupSitesDto,
  UpdateCollectionPointDto, UpdateGroupDto, CollectionPointDto,
} from '../dto/group.dto';
import { CONSOLIDATED_ACTION, ConsolidatedAuditService, RequestContext } from './consolidated-audit.service';
import { ConsolidatedAccessService } from './consolidated-access.service';
import { ConsolidatedNotifierService } from './consolidated-notifier.service';

/** Statuses where a group is in the middle of something and must not be archived. */
const LIVE_STATUSES: ConsolidatedCollectionStatus[] = [
  ConsolidatedCollectionStatus.OPEN,
  ConsolidatedCollectionStatus.SUBMISSIONS_CLOSED,
  ConsolidatedCollectionStatus.PUBLISHED,
  ConsolidatedCollectionStatus.CLAIMED,
  ConsolidatedCollectionStatus.AWAITING_ITEM_CHECK,
];

@Injectable()
export class ConsolidatedGroupService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ConsolidatedAccessService,
    private readonly audit: ConsolidatedAuditService,
    private readonly notifier?: ConsolidatedNotifierService,
  ) {}

  // ─── Invitations (Canva CM1: "invitation and accept process") ─────────────

  /**
   * Can this caller answer for the site? Its Site Admins can; for a site with
   * no Site Admin, the organisation's owner and admins answer instead.
   */
  private async canRespondFor(caller: Jwtpayload, siteIds: number[]): Promise<Set<number>> {
    if (!siteIds.length || !caller.orgId) return new Set();
    const admins = await this.prisma.siteAccess.findMany({
      where: { siteId: { in: siteIds }, siteRole: SiteRole.SITE_ADMIN },
      select: { siteId: true, userId: true },
    });
    const orgAdmin = caller.orgRole === OrgRole.SUPER_ADMIN || caller.orgRole === OrgRole.ORG_ADMIN;
    const out = new Set<number>();
    for (const siteId of siteIds) {
      const siteAdmins = admins.filter((a) => a.siteId === siteId);
      if (siteAdmins.some((a) => a.userId === caller.sub)) out.add(siteId);
      else if (siteAdmins.length === 0 && orgAdmin) out.add(siteId);
    }
    return out;
  }

  /**
   * A site joins straight away when the person adding it is someone who could
   * accept for it anyway; any other site gets an invitation to accept.
   */
  private async invitationData(caller: Jwtpayload, siteIds: number[]) {
    const own = await this.canRespondFor(caller, siteIds);
    const now = new Date();
    return new Map(
      siteIds.map((siteId) => [
        siteId,
        own.has(siteId)
          ? {
              invitationStatus: ConsolidatedSiteInvitationStatus.ACCEPTED,
              invitedAt: now, invitedByUserId: caller.sub,
              respondedAt: now, respondedByUserId: caller.sub, declineReason: null,
            }
          : {
              invitationStatus: ConsolidatedSiteInvitationStatus.PENDING,
              invitedAt: now, invitedByUserId: caller.sub,
              respondedAt: null, respondedByUserId: null, declineReason: null,
            },
      ]),
    );
  }

  /** Invitations the caller can answer, newest first. */
  async listInvitations(caller: Jwtpayload) {
    this.access.assertProductAccess(caller);
    if (!caller.orgId) return [];
    const pending = await this.prisma.consolidatedGroupSite.findMany({
      where: {
        invitationStatus: ConsolidatedSiteInvitationStatus.PENDING,
        removedAt: null,
        group: { organisationId: caller.orgId, isActive: true },
      },
      include: {
        site: { select: { id: true, name: true, organisationName: true, address: true } },
        group: {
          select: {
            id: true, name: true, description: true,
            hostSite: { select: { name: true, organisationName: true } },
            points: {
              where: { isActive: true },
              orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
              take: 1,
              select: { name: true, address: true, directions: true },
            },
            members: {
              where: { role: ConsolidatedMemberRole.MANAGER },
              select: { user: { select: { firstName: true, lastName: true } } },
            },
            _count: { select: { sites: { where: { removedAt: null } } } },
          },
        },
      },
      orderBy: { invitedAt: 'desc' },
    });
    const mine = await this.canRespondFor(caller, [...new Set(pending.map((p) => p.siteId))]);
    const inviterIds = [...new Set(pending.map((p) => p.invitedByUserId).filter((id): id is number => !!id))];
    const inviters = inviterIds.length
      ? await this.prisma.user.findMany({
          where: { id: { in: inviterIds } },
          select: { id: true, firstName: true, lastName: true },
        })
      : [];
    const inviterName = new Map(inviters.map((u) => [u.id, `${u.firstName} ${u.lastName}`.trim()]));

    return pending
      .filter((row) => mine.has(row.siteId))
      .map((row) => ({
        id: row.id,
        status: row.invitationStatus,
        invitedAt: row.invitedAt,
        invitedBy: row.invitedByUserId
          ? { id: row.invitedByUserId, name: inviterName.get(row.invitedByUserId) ?? 'A manager' }
          : null,
        site: { id: row.site.id, name: row.site.name ?? row.site.organisationName, address: row.site.address },
        group: {
          id: row.group.id,
          name: row.group.name,
          description: row.group.description,
          hostSiteName: row.group.hostSite?.name ?? row.group.hostSite?.organisationName ?? null,
          siteCount: row.group._count.sites,
          managers: row.group.members.map((m) => `${m.user.firstName} ${m.user.lastName}`.trim()),
          point: row.group.points[0] ?? null,
        },
      }));
  }

  async respondToInvitation(
    caller: Jwtpayload, groupSiteId: number, accept: boolean, reason?: string, req?: RequestContext,
  ) {
    this.access.assertProductAccess(caller);
    const row = await this.prisma.consolidatedGroupSite.findFirst({
      where: { id: groupSiteId, group: { organisationId: caller.orgId } },
      include: {
        site: { select: { name: true, organisationName: true } },
        group: { select: { id: true, name: true, organisationId: true } },
      },
    });
    if (!row || row.removedAt) throw new NotFoundException('Invitation not found.');
    if (!(await this.canRespondFor(caller, [row.siteId])).has(row.siteId)) {
      throw new NotFoundException('Invitation not found.');
    }
    if (row.invitationStatus !== ConsolidatedSiteInvitationStatus.PENDING) {
      throw new ConflictException(`This invitation was already ${row.invitationStatus.toLowerCase()}.`);
    }

    const actor = await this.audit.actorFrom(caller, req);
    const now = new Date();
    const siteName = row.site.name ?? row.site.organisationName;

    const result = await this.prisma.$transaction(async (tx) => {
      await tx.consolidatedGroupSite.update({
        where: { id: groupSiteId },
        data: accept
          ? {
              invitationStatus: ConsolidatedSiteInvitationStatus.ACCEPTED,
              respondedAt: now, respondedByUserId: caller.sub, declineReason: null,
            }
          : {
              invitationStatus: ConsolidatedSiteInvitationStatus.DECLINED,
              respondedAt: now, respondedByUserId: caller.sub,
              declineReason: reason?.trim() || null,
              // Out of the group, history kept; the manager can invite it again.
              removedAt: now,
            },
      });

      let joined = 0;
      if (accept) {
        // A recurring series set to "all sites" should pick the newcomer up for
        // every occurrence that has not opened for listing yet or is still open.
        const schedules = await tx.consolidatedSchedule.findMany({
          where: { groupId: row.groupId, status: ConsolidatedScheduleStatus.ACTIVE },
          select: { id: true, participatingSiteIds: true },
        });
        for (const schedule of schedules) {
          if (!schedule.participatingSiteIds.includes(row.siteId)) {
            await tx.consolidatedSchedule.update({
              where: { id: schedule.id },
              data: { participatingSiteIds: { push: row.siteId } },
            });
          }
        }
        const collections = await tx.consolidatedCollection.findMany({
          where: {
            groupId: row.groupId,
            isDetached: false,
            status: { in: [ConsolidatedCollectionStatus.SCHEDULED, ConsolidatedCollectionStatus.OPEN] },
            NOT: { participatingSiteIds: { has: row.siteId } },
          },
          select: { id: true },
        });
        for (const collection of collections) {
          await tx.consolidatedCollection.update({
            where: { id: collection.id },
            data: { participatingSiteIds: { push: row.siteId } },
          });
        }
        joined = collections.length;
      }

      await this.audit.log(tx, actor, {
        organisationId: row.group.organisationId,
        action: CONSOLIDATED_ACTION.GROUP_SITES_CHANGED,
        entityType: 'ConsolidatedGroup',
        entityId: row.groupId,
        entityLabel: row.group.name,
        newValue: { siteId: row.siteId, invitationStatus: accept ? 'ACCEPTED' : 'DECLINED', reason: reason ?? null },
        summary: accept
          ? `${siteName} accepted the invitation to "${row.group.name}"` +
            (joined ? ` and joined ${joined} upcoming collection(s).` : '.')
          : `${siteName} declined the invitation to "${row.group.name}"${reason ? `: ${reason.trim()}` : '.'}`,
      });

      return { id: groupSiteId, status: accept ? 'ACCEPTED' : 'DECLINED', collectionsJoined: joined };
    });

    await this.notifier?.invitationAnswered(groupSiteId, accept).catch(() => undefined);
    return result;
  }

  // ─── Create ────────────────────────────────────────────────────────────────

  async create(caller: Jwtpayload, dto: CreateGroupDto, req?: RequestContext) {
    const siteIds = [...new Set(dto.siteIds)];
    await this.access.assertCanCreateGroup(caller, siteIds);

    if (!siteIds.includes(dto.hostSiteId)) {
      throw new BadRequestException('The host site must be one of the participating sites.');
    }

    const timezone = await this.resolveTimezone(dto.hostSiteId, dto.timezone);
    const orgId = caller.orgId!;
    const members = this.normaliseMembers(caller, dto.members);
    await this.assertMembersManageable(orgId, members);

    const actor = await this.audit.actorFrom(caller, req);
    const invitations = await this.invitationData(caller, siteIds);

    const created = await this.prisma.$transaction(async (tx) => {
      const group = await tx.consolidatedGroup.create({
        data: {
          organisationId: orgId,
          name: dto.name.trim(),
          description: dto.description?.trim(),
          hostSiteId: dto.hostSiteId,
          timezone,
          createdByUserId: caller.sub,
          points: { create: { ...this.pointData(dto.collectionPoint), isDefault: true } },
          sites: {
            create: siteIds.map((siteId) => ({ siteId, addedBy: caller.sub, ...invitations.get(siteId)! })),
          },
          members: { create: members.map((m) => ({ ...m, addedBy: caller.sub })) },
        },
        include: { points: true, sites: true, members: true },
      });

      await this.audit.log(tx, actor, {
        organisationId: orgId,
        action: CONSOLIDATED_ACTION.GROUP_CREATED,
        entityType: 'ConsolidatedGroup',
        entityId: group.id,
        entityLabel: group.name,
        newValue: { siteIds, hostSiteId: dto.hostSiteId, timezone },
        summary: `Created collection group "${group.name}" with ${siteIds.length} site(s).`,
      });

      return group;
    });

    const pendingIds = created.sites
      .filter((s) => s.invitationStatus === ConsolidatedSiteInvitationStatus.PENDING)
      .map((s) => s.id);
    await this.notifier?.sitesInvited(pendingIds).catch(() => undefined);
    return created;
  }

  // ─── Read ──────────────────────────────────────────────────────────────────

  async list(caller: Jwtpayload, query: GroupListQueryDto) {
    this.access.assertProductAccess(caller);
    const reach = await this.access.callerSiteIds(caller);

    const where: Prisma.ConsolidatedGroupWhereInput = {
      organisationId: caller.orgId,
      ...(query.includeArchived ? {} : { isActive: true }),
      ...(query.search ? { name: { contains: query.search, mode: 'insensitive' } } : {}),
      // A site admin only sees groups made entirely of sites they administer.
      ...(reach === null ? {} : { sites: { every: { siteId: { in: reach } } } }),
    };

    const groups = await this.prisma.consolidatedGroup.findMany({
      where,
      orderBy: { name: 'asc' },
      include: {
        hostSite: { select: { id: true, name: true, organisationName: true } },
        _count: { select: { sites: { where: { removedAt: null } }, points: true } },
        sites: { where: { removedAt: null }, select: { invitationStatus: true } },
        collections: {
          where: { status: { in: [ConsolidatedCollectionStatus.SCHEDULED, ConsolidatedCollectionStatus.OPEN] } },
          orderBy: { scheduledDate: 'asc' },
          take: 1,
          select: { id: true, scheduledDate: true, status: true },
        },
      },
    });

    return groups.map((g) => ({
      id: g.id,
      name: g.name,
      hostSite: g.hostSite ? { id: g.hostSite.id, name: g.hostSite.name ?? g.hostSite.organisationName } : null,
      siteCount: g._count.sites,
      acceptedSiteCount: g.sites.filter((s) => s.invitationStatus === ConsolidatedSiteInvitationStatus.ACCEPTED).length,
      pendingSiteCount: g.sites.filter((s) => s.invitationStatus === ConsolidatedSiteInvitationStatus.PENDING).length,
      pointCount: g._count.points,
      nextCollection: g.collections[0] ?? null,
      isActive: g.isActive,
    }));
  }

  async get(caller: Jwtpayload, groupId: number) {
    await this.access.assertReceiver(caller, groupId);

    return this.prisma.consolidatedGroup.findUniqueOrThrow({
      where: { id: groupId },
      include: {
        hostSite: { select: { id: true, name: true, organisationName: true } },
        points: { where: { isActive: true }, orderBy: [{ isDefault: 'desc' }, { name: 'asc' }] },
        // Declined sites stay visible (with removedAt set) so the manager can re-invite.
        sites: {
          where: {
            OR: [{ removedAt: null }, { invitationStatus: ConsolidatedSiteInvitationStatus.DECLINED }],
          },
          include: { site: { select: { id: true, name: true, organisationName: true, timezone: true } } },
        },
        members: {
          include: { user: { select: { id: true, firstName: true, lastName: true, email: true } } },
        },
        schedules: { where: { status: ConsolidatedScheduleStatus.ACTIVE } },
      },
    });
  }

  /** Sites the caller could add to a group: active, in the org, within reach. */
  async eligibleSites(caller: Jwtpayload) {
    await this.access.assertCanManage(caller);
    const reach = await this.access.callerSiteIds(caller);

    return this.prisma.site.findMany({
      where: {
        organisationId: caller.orgId,
        isActive: true,
        ...(reach === null ? {} : { id: { in: reach } }),
      },
      select: { id: true, name: true, organisationName: true, address: true, timezone: true },
      orderBy: { organisationName: 'asc' },
    });
  }

  /** Org members, flagged with whether they could be made a manager. */
  async eligibleUsers(caller: Jwtpayload) {
    await this.access.assertCanManage(caller);

    const memberships = await this.prisma.orgMemeberShip.findMany({
      where: { organisationId: caller.orgId },
      include: { user: { select: { id: true, firstName: true, lastName: true, email: true } } },
    });

    const siteAdmins = new Set(
      (
        await this.prisma.siteAccess.findMany({
          where: { organisationId: caller.orgId, siteRole: 'SITE_ADMIN' },
          select: { userId: true },
        })
      ).map((r) => r.userId),
    );

    return memberships.map((m) => ({
      id: m.user.id,
      name: `${m.user.firstName} ${m.user.lastName}`.trim(),
      email: m.user.email,
      orgRole: m.orgRole,
      isSiteAdmin: siteAdmins.has(m.user.id),
      canManage: m.canManageConsolidated || m.orgRole === 'SUPER_ADMIN',
    }));
  }

  // ─── Update ────────────────────────────────────────────────────────────────

  async update(caller: Jwtpayload, groupId: number, dto: UpdateGroupDto, req?: RequestContext) {
    const group = await this.access.assertManager(caller, groupId);
    const actor = await this.audit.actorFrom(caller, req);

    if (dto.hostSiteId && !group.sites.some((s) => s.siteId === dto.hostSiteId)) {
      throw new BadRequestException('The host site must be one of the participating sites.');
    }
    if (dto.timezone) assertValidTimezone(dto.timezone);

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.consolidatedGroup.update({
        where: { id: groupId },
        data: {
          name: dto.name?.trim(),
          description: dto.description?.trim(),
          hostSiteId: dto.hostSiteId,
          timezone: dto.timezone,
        },
      });

      await this.audit.log(tx, actor, {
        organisationId: group.organisationId,
        action: CONSOLIDATED_ACTION.GROUP_UPDATED,
        entityType: 'ConsolidatedGroup',
        entityId: groupId,
        entityLabel: updated.name,
        previousValue: { name: group.name, hostSiteId: group.hostSiteId, timezone: group.timezone },
        newValue: { name: updated.name, hostSiteId: updated.hostSiteId, timezone: updated.timezone },
        summary: `Updated collection group "${updated.name}".`,
      });

      return updated;
    });
  }

  /**
   * Replaces the site list.
   *
   * Removal is soft — historical collections keep pointing at the membership
   * row, so a site leaving a group never rewrites what it already contributed.
   */
  async setSites(caller: Jwtpayload, groupId: number, dto: SetGroupSitesDto, req?: RequestContext) {
    const group = await this.access.assertManager(caller, groupId);
    const siteIds = [...new Set(dto.siteIds)];
    await this.access.assertCanCreateGroup(caller, siteIds);

    const hostSiteId = dto.hostSiteId ?? group.hostSiteId;
    if (!siteIds.includes(hostSiteId)) {
      throw new BadRequestException(
        'The host site is being removed. Choose a new host site from the remaining sites.',
      );
    }

    const current = group.sites.map((s) => s.siteId);
    const added = siteIds.filter((id) => !current.includes(id));
    const removed = current.filter((id) => !siteIds.includes(id));
    const actor = await this.audit.actorFrom(caller, req);
    const invitations = await this.invitationData(caller, added);

    const result = await this.prisma.$transaction(async (tx) => {
      if (removed.length) {
        await tx.consolidatedGroupSite.updateMany({
          where: { groupId, siteId: { in: removed }, removedAt: null },
          data: { removedAt: new Date() },
        });
      }

      for (const siteId of added) {
        // A site that was removed before is restored rather than duplicated.
        await tx.consolidatedGroupSite.upsert({
          where: { groupId_siteId: { groupId, siteId } },
          create: { groupId, siteId, addedBy: caller.sub, ...invitations.get(siteId)! },
          // Re-adding a removed or declined site sends a fresh invitation.
          update: { removedAt: null, addedAt: new Date(), addedBy: caller.sub, ...invitations.get(siteId)! },
        });
      }

      await tx.consolidatedGroup.update({ where: { id: groupId }, data: { hostSiteId } });

      // Collections that have not opened yet follow the group. Anything already
      // open keeps the site list it was generated with.
      // Only sites that have accepted take part; invited ones join when they accept.
      const accepted = (
        await tx.consolidatedGroupSite.findMany({
          where: { groupId, removedAt: null, invitationStatus: ConsolidatedSiteInvitationStatus.ACCEPTED },
          select: { siteId: true },
        })
      ).map((s) => s.siteId);
      await tx.consolidatedCollection.updateMany({
        where: { groupId, status: ConsolidatedCollectionStatus.SCHEDULED, isDetached: false },
        data: { participatingSiteIds: accepted },
      });

      await this.audit.log(tx, actor, {
        organisationId: group.organisationId,
        action: CONSOLIDATED_ACTION.GROUP_SITES_CHANGED,
        entityType: 'ConsolidatedGroup',
        entityId: groupId,
        entityLabel: group.name,
        previousValue: { siteIds: current },
        newValue: { siteIds, hostSiteId },
        summary:
          `Sites changed on "${group.name}": ` +
          `${added.length} added, ${removed.length} removed.`,
      });

      return { siteIds, hostSiteId, added, removed };
    });

    const invited = await this.prisma.consolidatedGroupSite.findMany({
      where: {
        groupId, siteId: { in: added },
        invitationStatus: ConsolidatedSiteInvitationStatus.PENDING,
      },
      select: { id: true },
    });
    await this.notifier?.sitesInvited(invited.map((r) => r.id)).catch(() => undefined);
    return { ...result, invited: invited.length };
  }

  async setMembers(caller: Jwtpayload, groupId: number, dto: SetGroupMembersDto, req?: RequestContext) {
    const group = await this.access.assertManager(caller, groupId);
    const members = this.normaliseMembers(caller, dto.members);
    await this.assertMembersManageable(group.organisationId, members);
    const actor = await this.audit.actorFrom(caller, req);

    return this.prisma.$transaction(async (tx) => {
      await tx.consolidatedGroupMember.deleteMany({ where: { groupId } });
      await tx.consolidatedGroupMember.createMany({
        data: members.map((m) => ({ ...m, groupId, addedBy: caller.sub })),
      });

      await this.audit.log(tx, actor, {
        organisationId: group.organisationId,
        action: CONSOLIDATED_ACTION.GROUP_MEMBERS_CHANGED,
        entityType: 'ConsolidatedGroup',
        entityId: groupId,
        entityLabel: group.name,
        newValue: { members },
        summary: `Members changed on "${group.name}".`,
      });

      return tx.consolidatedGroupMember.findMany({ where: { groupId } });
    });
  }

  // ─── Points ────────────────────────────────────────────────────────────────

  async addPoint(caller: Jwtpayload, groupId: number, dto: CollectionPointDto, req?: RequestContext) {
    const group = await this.access.assertManager(caller, groupId);
    const actor = await this.audit.actorFrom(caller, req);

    return this.prisma.$transaction(async (tx) => {
      const point = await tx.consolidatedCollectionPoint.create({
        data: { groupId, ...this.pointData(dto) },
      });

      await this.audit.log(tx, actor, {
        organisationId: group.organisationId,
        action: CONSOLIDATED_ACTION.POINT_CREATED,
        entityType: 'ConsolidatedCollectionPoint',
        entityId: point.id,
        entityLabel: point.name,
        newValue: { name: point.name, address: point.address },
        summary: `Added collection point "${point.name}" to "${group.name}".`,
      });

      return point;
    });
  }

  /**
   * Editing a point never rewrites history — each collection carries its own
   * snapshot of the point as it was when generated.
   */
  async updatePoint(
    caller: Jwtpayload, groupId: number, pointId: number,
    dto: UpdateCollectionPointDto, req?: RequestContext,
  ) {
    const group = await this.access.assertManager(caller, groupId);
    const existing = await this.prisma.consolidatedCollectionPoint.findFirst({
      where: { id: pointId, groupId },
    });
    if (!existing) throw new NotFoundException('Collection point not found.');

    const actor = await this.audit.actorFrom(caller, req);

    return this.prisma.$transaction(async (tx) => {
      if (dto.isDefault) {
        await tx.consolidatedCollectionPoint.updateMany({
          where: { groupId }, data: { isDefault: false },
        });
      }

      const point = await tx.consolidatedCollectionPoint.update({
        where: { id: pointId },
        data: {
          name: dto.name?.trim(), address: dto.address?.trim(), postcode: dto.postcode,
          lat: dto.lat, lng: dto.lng, directions: dto.directions,
          isDefault: dto.isDefault, isActive: dto.isActive,
        },
      });

      await this.audit.log(tx, actor, {
        organisationId: group.organisationId,
        action: CONSOLIDATED_ACTION.POINT_UPDATED,
        entityType: 'ConsolidatedCollectionPoint',
        entityId: pointId,
        entityLabel: point.name,
        previousValue: { name: existing.name, address: existing.address, isActive: existing.isActive },
        newValue: { name: point.name, address: point.address, isActive: point.isActive },
        summary: `Updated collection point "${point.name}".`,
      });

      return point;
    });
  }

  // ─── Archive ───────────────────────────────────────────────────────────────

  /**
   * Archiving ends the schedules and cancels anything not yet started. It
   * refuses while a collection is live, because sites and charities are
   * already acting on it.
   */
  async archive(caller: Jwtpayload, groupId: number, req?: RequestContext) {
    const group = await this.access.assertManager(caller, groupId);

    const live = await this.prisma.consolidatedCollection.count({
      where: { groupId, status: { in: LIVE_STATUSES } },
    });
    if (live > 0) {
      throw new ConflictException({
        error: CONSOLIDATED_ERROR.GROUP_HAS_ACTIVE_COLLECTIONS,
        message: `This group has ${live} collection(s) in progress. Finish or cancel them first.`,
      });
    }

    const actor = await this.audit.actorFrom(caller, req);
    const now = new Date();

    return this.prisma.$transaction(async (tx) => {
      await tx.consolidatedGroup.update({
        where: { id: groupId },
        data: { isActive: false, archivedAt: now },
      });
      await tx.consolidatedSchedule.updateMany({
        where: { groupId, status: ConsolidatedScheduleStatus.ACTIVE },
        data: { status: ConsolidatedScheduleStatus.ENDED, endDate: now },
      });
      const cancelled = await tx.consolidatedCollection.updateMany({
        where: { groupId, status: ConsolidatedCollectionStatus.SCHEDULED },
        data: {
          status: ConsolidatedCollectionStatus.CANCELLED,
          cancelledAt: now,
          cancelledByUserId: caller.sub,
          cancelReason: 'Collection group archived',
        },
      });

      await this.audit.log(tx, actor, {
        organisationId: group.organisationId,
        action: CONSOLIDATED_ACTION.GROUP_ARCHIVED,
        entityType: 'ConsolidatedGroup',
        entityId: groupId,
        entityLabel: group.name,
        summary: `Archived "${group.name}". ${cancelled.count} scheduled collection(s) cancelled.`,
      });

      return { archived: true, cancelledCollections: cancelled.count };
    });
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private pointData(dto: CollectionPointDto) {
    return {
      name: dto.name.trim(),
      address: dto.address.trim(),
      postcode: dto.postcode,
      lat: dto.lat,
      lng: dto.lng,
      directions: dto.directions?.trim(),
    };
  }

  /**
   * The timezone decides when a 2pm window actually happens, so it must be
   * explicit — a site without one is a configuration error, not a default.
   */
  private async resolveTimezone(hostSiteId: number, override?: string): Promise<string> {
    if (override) {
      assertValidTimezone(override);
      return override;
    }

    const site = await this.prisma.site.findUnique({
      where: { id: hostSiteId },
      select: { timezone: true },
    });
    const resolved = resolveDonorTimezone(site?.timezone);
    if (!resolved) {
      throw new BadRequestException(
        'Set a timezone for the host site, or give the group one.',
      );
    }
    assertValidTimezone(resolved);
    return resolved;
  }

  /** The creator always manages their own group, listed or not. */
  private normaliseMembers(caller: Jwtpayload, members?: { userId: number; role: ConsolidatedMemberRole }[]) {
    const out = new Map<string, { userId: number; role: ConsolidatedMemberRole }>();
    for (const m of members ?? []) out.set(`${m.userId}:${m.role}`, m);
    out.set(`${caller.sub}:${ConsolidatedMemberRole.MANAGER}`, {
      userId: caller.sub,
      role: ConsolidatedMemberRole.MANAGER,
    });
    return [...out.values()];
  }

  /**
   * A manager must independently hold the manage permission — being named on a
   * group cannot grant it (R1).
   */
  private async assertMembersManageable(
    orgId: number,
    members: { userId: number; role: ConsolidatedMemberRole }[],
  ) {
    const userIds = [...new Set(members.map((m) => m.userId))];
    const memberships = await this.prisma.orgMemeberShip.findMany({
      where: { organisationId: orgId, userId: { in: userIds } },
      select: { userId: true, orgRole: true, canManageConsolidated: true },
    });

    const byUser = new Map(memberships.map((m) => [m.userId, m]));
    for (const userId of userIds) {
      if (!byUser.has(userId)) {
        throw new BadRequestException(`User ${userId} is not a member of this organisation.`);
      }
    }

    for (const m of members.filter((x) => x.role === ConsolidatedMemberRole.MANAGER)) {
      const membership = byUser.get(m.userId)!;
      const allowed = membership.orgRole === 'SUPER_ADMIN' || membership.canManageConsolidated;
      if (!allowed) {
        throw new BadRequestException(
          `User ${m.userId} needs the "manage collections" permission before they can be a manager.`,
        );
      }
    }
  }
}
