import { Injectable, Logger } from '@nestjs/common';
import { AuditArea, Prisma } from '@prisma/client';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { Jwtpayload } from '../../auth/interface/jwt.interface';

/**
 * Action slugs. Fixed strings rather than free text, so the audit screen can
 * filter and label them without guessing.
 */
export const CONSOLIDATED_ACTION = {
  GROUP_CREATED: 'group.created',
  GROUP_UPDATED: 'group.updated',
  GROUP_ARCHIVED: 'group.archived',
  GROUP_SITES_CHANGED: 'group.sites_changed',
  GROUP_MEMBERS_CHANGED: 'group.members_changed',
  POINT_CREATED: 'point.created',
  POINT_UPDATED: 'point.updated',
  PERMISSION_CHANGED: 'permission.changed',
  SCHEDULE_CREATED: 'schedule.created',
  SCHEDULE_UPDATED: 'schedule.updated',
  SCHEDULE_ENDED: 'schedule.ended',
  COLLECTION_GENERATED: 'collection.generated',
  COLLECTION_UPDATED: 'collection.updated',
  COLLECTION_OPENED: 'collection.opened',
  COLLECTION_CLOSED: 'collection.closed',
  COLLECTION_REOPENED: 'collection.reopened',
  COLLECTION_CANCELLED: 'collection.cancelled',
  COLLECTION_PUBLISHED: 'collection.published',
  COLLECTION_REPUBLISHED: 'collection.republished',
  COLLECTION_CLAIMED: 'collection.claimed',
  COLLECTION_CLAIM_CANCELLED: 'collection.claim_cancelled',
  COLLECTION_COMPLETED: 'collection.completed',
  COLLECTION_EXPIRED: 'collection.expired',
  CONTRIBUTION_SUBMITTED: 'contribution.submitted',
  CONTRIBUTION_LATE_SUBMITTED: 'contribution.late_submitted',
  CONTRIBUTION_LATE_APPROVED: 'contribution.late_approved',
  CONTRIBUTION_LATE_REJECTED: 'contribution.late_rejected',
  CONTRIBUTION_UPDATED: 'contribution.updated',
  CONTRIBUTION_WITHDRAWN: 'contribution.withdrawn',
  CONTRIBUTION_HANDOVER: 'contribution.handover',
  CONTRIBUTION_RECEIPT: 'contribution.receipt',
  CONTRIBUTION_EXCLUDED: 'contribution.excluded',
  CHANGE_REQUEST_CREATED: 'change_request.created',
  CHANGE_REQUEST_APPROVED: 'change_request.approved',
  CHANGE_REQUEST_REJECTED: 'change_request.rejected',
  CHANGE_MATERIAL_CREATED: 'change.material_created',
  CHANGE_ACKNOWLEDGED: 'change.acknowledged',
  ITEM_CHECK_SUBMITTED: 'item_check.submitted',
  REMINDER_SENT: 'reminder.sent',
} as const;

export type ConsolidatedAction =
  (typeof CONSOLIDATED_ACTION)[keyof typeof CONSOLIDATED_ACTION];

export interface ConsolidatedAuditEntry {
  organisationId: number;
  action: ConsolidatedAction;
  entityType: string;
  entityId?: number | null;
  entityLabel?: string | null;
  /** Only the fields that moved — a whole entity makes the panel unreadable. */
  previousValue?: Prisma.InputJsonValue | null;
  newValue?: Prisma.InputJsonValue | null;
  /** One line already written for a human. */
  summary: string;
}

export interface RequestContext {
  ip?: string;
  headers?: Record<string, unknown>;
}

/** A Prisma client or an open transaction — audit writes join the caller's. */
type Db = PrismaService | Prisma.TransactionClient;

/**
 * Audit for Consolidated Collections.
 *
 * Every state-changing service method logs inside its own transaction, so a
 * change and its record either both land or neither does. Append-only: there
 * is deliberately no update or delete.
 */
@Injectable()
export class ConsolidatedAuditService {
  private readonly logger = new Logger(ConsolidatedAuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Resolves the actor once per request. Name and email are copied in rather
   * than joined, so the log still reads correctly after a user is deleted.
   */
  async actorFrom(caller: Jwtpayload, req?: RequestContext) {
    const user = await this.prisma.user.findUnique({
      where: { id: caller.sub },
      select: { firstName: true, lastName: true, email: true },
    });

    const header = (name: string) => {
      const value = req?.headers?.[name];
      return typeof value === 'string' ? value : undefined;
    };

    return {
      userId: caller.sub,
      name: user ? `${user.firstName} ${user.lastName}`.trim() : caller.email,
      email: user?.email ?? caller.email,
      ipAddress: req?.ip ?? null,
      userAgent: header('user-agent') ?? null,
    };
  }

  /**
   * Writes one record. A failure here is logged, never thrown: losing an audit
   * line must not roll back the change the user actually asked for.
   */
  async log(
    db: Db,
    actor: Awaited<ReturnType<ConsolidatedAuditService['actorFrom']>>,
    entry: ConsolidatedAuditEntry,
  ): Promise<void> {
    try {
      await db.auditLog.create({
        data: {
          organisationId: entry.organisationId,
          actorUserId: actor.userId,
          actorName: actor.name,
          actorEmail: actor.email,
          area: AuditArea.CONSOLIDATED_COLLECTIONS,
          action: entry.action,
          entityType: entry.entityType,
          entityId: entry.entityId ?? null,
          entityLabel: entry.entityLabel ?? null,
          previousValue: entry.previousValue ?? Prisma.DbNull,
          newValue: entry.newValue ?? Prisma.DbNull,
          summary: entry.summary,
          ipAddress: actor.ipAddress,
          userAgent: actor.userAgent,
        },
      });
    } catch (error) {
      this.logger.error(
        `Audit write failed for ${entry.action} on ${entry.entityType} ${entry.entityId ?? ''}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
