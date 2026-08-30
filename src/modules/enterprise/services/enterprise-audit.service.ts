import { Injectable, Logger } from '@nestjs/common';
import { AuditArea, Prisma } from '@prisma/client';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { Jwtpayload } from '../../auth/interface/jwt.interface';

/**
 * One audit record. `previousValue`/`newValue` back the change-detail panel,
 * so only include the fields that actually moved — dumping whole entities
 * makes the panel unreadable.
 */
export interface AuditEntry {
  organisationId: number;
  area: AuditArea;
  /** Stable slug, e.g. `site.reassigned`, `user.access_changed`. */
  action: string;
  entityType: string;
  entityId?: number | null;
  entityLabel?: string | null;
  previousValue?: Prisma.InputJsonValue | null;
  newValue?: Prisma.InputJsonValue | null;
  /** One line, already written for a human: "Perth College moved to Territory: WA". */
  summary: string;
}

export interface AuditActor {
  userId: number | null;
  name: string;
  email: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export interface AuditLogQuery {
  organisationId?: number;
  from?: Date;
  to?: Date;
  area?: AuditArea;
  actorUserId?: number;
  search?: string;
  skip: number;
  take: number;
}

/**
 * Administrative changes to Sites, Users, Organisation Structure and Enterprise
 * Settings. Routine operational activity belongs in Activity, not here.
 *
 * Records are append-only: there is deliberately no update or delete method.
 */
@Injectable()
export class EnterpriseAuditService {
  private readonly logger = new Logger(EnterpriseAuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Resolves the acting user's name and email once, so the log still reads
   * correctly after that user is deleted.
   */
  async actorFrom(
    caller: Jwtpayload,
    req?: { ip?: string; headers?: Record<string, unknown> },
  ): Promise<AuditActor> {
    const user = await this.prisma.user.findUnique({
      where: { id: caller.sub },
      select: { firstName: true, lastName: true, email: true },
    });

    return {
      userId: caller.sub,
      name: user ? `${user.firstName} ${user.lastName}`.trim() : 'Unknown user',
      email: user?.email ?? '',
      ipAddress: req?.ip ?? null,
      userAgent: (req?.headers?.['user-agent'] as string | undefined) ?? null,
    };
  }

  /**
   * Writes one record. Never throws: an audit failure must not roll back the
   * change the user actually asked for — it is logged and swallowed.
   */
  async record(actor: AuditActor, entry: AuditEntry): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          organisationId: entry.organisationId,
          actorUserId: actor.userId,
          actorName: actor.name,
          actorEmail: actor.email,
          area: entry.area,
          action: entry.action,
          entityType: entry.entityType,
          entityId: entry.entityId ?? null,
          entityLabel: entry.entityLabel ?? null,
          previousValue: entry.previousValue ?? Prisma.DbNull,
          newValue: entry.newValue ?? Prisma.DbNull,
          summary: entry.summary,
          ipAddress: actor.ipAddress ?? null,
          userAgent: actor.userAgent ?? null,
        },
      });
    } catch (err) {
      this.logger.error(
        `audit write failed (${entry.area}/${entry.action}): ${(err as Error).message}`,
      );
    }
  }

  /** Convenience wrapper for the common case of one caller, one entry. */
  async recordFor(
    caller: Jwtpayload,
    entry: AuditEntry,
    req?: { ip?: string; headers?: Record<string, unknown> },
  ): Promise<void> {
    await this.record(await this.actorFrom(caller, req), entry);
  }

  // ─── Reading ───────────────────────────────────────────────────────────────

  async list(organisationId: number, query: AuditLogQuery) {
    return this.listAll({ ...query, organisationId });
  }

  async listAll(query: AuditLogQuery) {
    const where: Prisma.AuditLogWhereInput = {
      ...(query.organisationId ? { organisationId: query.organisationId } : {}),
      ...(query.area ? { area: query.area } : {}),
      ...(query.actorUserId ? { actorUserId: query.actorUserId } : {}),
      ...(query.from || query.to
        ? {
            createdAt: {
              ...(query.from ? { gte: query.from } : {}),
              ...(query.to ? { lte: query.to } : {}),
            },
          }
        : {}),
      ...(query.search
        ? {
            OR: [
              { summary: { contains: query.search, mode: 'insensitive' } },
              { actorName: { contains: query.search, mode: 'insensitive' } },
              { entityLabel: { contains: query.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.auditLog.count({ where }),
      this.prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: query.skip,
        take: query.take,
        include: { organisation: { select: { id: true, name: true } } },
      }),
    ]);

    return { total, rows };
  }

  async getOne(organisationId: number, id: number) {
    return this.prisma.auditLog.findFirst({ where: { id, organisationId } });
  }

  /**
   * Builds `previous`/`next` objects containing only the keys that changed,
   * so the detail panel shows the change rather than the whole record.
   */
  static diff<T extends Record<string, unknown>>(
    before: T,
    after: Partial<T>,
  ): { previous: Prisma.InputJsonObject; next: Prisma.InputJsonObject } | null {
    // Built mutably, then widened — InputJsonObject's index signature is readonly.
    const previous: Record<string, Prisma.InputJsonValue> = {};
    const next: Record<string, Prisma.InputJsonValue> = {};

    for (const [key, value] of Object.entries(after)) {
      if (value === undefined) continue;
      if (before[key] === value) continue;
      previous[key] = (before[key] ?? null) as Prisma.InputJsonValue;
      next[key] = value as Prisma.InputJsonValue;
    }

    return Object.keys(next).length ? { previous, next } : null;
  }
}
