import { Injectable, Logger } from '@nestjs/common';
import { ConsolidatedMemberRole, SiteRole } from '@prisma/client';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { NotificationService } from '../../notifications/services/notification.service';
import { formatWindowRange } from '../../connections/connection.schedule';

/** `data.type` values the apps switch on to pick a screen. */
export const CONSOLIDATED_PUSH = {
  SCHEDULED: 'CONSOLIDATED_SCHEDULED',
  CLOSING_SOON: 'CONSOLIDATED_CLOSING_SOON',
  CLOSED: 'CONSOLIDATED_CLOSED',
  REMINDER: 'CONSOLIDATED_REMINDER',
  OVERDUE: 'CONSOLIDATED_OVERDUE',
  LATE_REQUEST: 'CONSOLIDATED_LATE_REQUEST',
  LATE_DECIDED: 'CONSOLIDATED_LATE_DECIDED',
  HANDOVER: 'CONSOLIDATED_HANDOVER',
  RECEIPT: 'CONSOLIDATED_RECEIPT',
  PUBLISHED: 'CONSOLIDATED_PUBLISHED',
  CLAIMED: 'CONSOLIDATED_CLAIMED',
  PICKUP_SOON: 'CONSOLIDATED_PICKUP_SOON',
  CHANGE_REQUEST: 'CONSOLIDATED_CHANGE_REQUEST',
  MATERIAL_CHANGE: 'CONSOLIDATED_MATERIAL_CHANGE',
  ITEM_CHECK_DUE: 'CONSOLIDATED_ITEM_CHECK_DUE',
  COMPLETED: 'CONSOLIDATED_COMPLETED',
  CANCELLED: 'CONSOLIDATED_CANCELLED',
} as const;

export type ConsolidatedPushType =
  (typeof CONSOLIDATED_PUSH)[keyof typeof CONSOLIDATED_PUSH];

/**
 * Every push this feature sends.
 *
 * Failures are logged and swallowed: a collection that is closed, published or
 * cancelled must not roll back because a device token was stale. The database
 * is the record, the push is a nudge.
 *
 * Charity-facing copy never names a contributing site (SPEC §2.4).
 */
@Injectable()
export class ConsolidatedNotifierService {
  private readonly logger = new Logger(ConsolidatedNotifierService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationService,
  ) {}

  // ─── Recipients ────────────────────────────────────────────────────────────

  /** Staff who can actually act on a listing for this site. */
  private async siteStaffIds(siteIds: number[]): Promise<number[]> {
    if (!siteIds.length) return [];
    const access = await this.prisma.siteAccess.findMany({
      where: { siteId: { in: siteIds }, siteRole: { in: [SiteRole.SITE_ADMIN, SiteRole.STAFF] } },
      select: { userId: true },
    });
    return [...new Set(access.map((a) => a.userId))];
  }

  private async groupMemberIds(
    groupId: number,
    roles: ConsolidatedMemberRole[] = [ConsolidatedMemberRole.MANAGER, ConsolidatedMemberRole.RECEIVER],
  ): Promise<number[]> {
    const members = await this.prisma.consolidatedGroupMember.findMany({
      where: { groupId, role: { in: roles } },
      select: { userId: true },
    });
    return [...new Set(members.map((m) => m.userId))];
  }

  private async charityUserIds(claimId: number): Promise<number[]> {
    const claim = await this.prisma.foodClaim.findUnique({
      where: { id: claimId },
      select: { claimantOrgId: true, claimantSiteId: true },
    });
    if (!claim) return [];

    const [members, siteAdmins] = await Promise.all([
      this.prisma.orgMemeberShip.findMany({
        where: { organisationId: claim.claimantOrgId, orgRole: 'SUPER_ADMIN' },
        select: { userId: true },
      }),
      claim.claimantSiteId
        ? this.prisma.siteAccess.findMany({
            where: { siteId: claim.claimantSiteId },
            select: { userId: true },
          })
        : Promise.resolve([]),
    ]);
    return [...new Set([...members, ...siteAdmins].map((m) => m.userId))];
  }

  private async push(
    userIds: number[],
    title: string,
    body: string,
    data: Record<string, string>,
    priority: 'low' | 'normal' | 'high' = 'normal',
  ): Promise<void> {
    if (!userIds.length) {
      this.logger.warn(`No recipients for ${data.type} — nothing sent`);
      return;
    }
    try {
      await this.notifications.send({
        title,
        body,
        data,
        priority,
        targetUserIds: userIds.map(String),
        targetApp: 'business',
        allowEmptyTargets: true,
      });
    } catch (err) {
      this.logger.error(`Push failed (${data.type}): ${(err as Error).message}`);
    }
  }

  // ─── Shared loader ─────────────────────────────────────────────────────────

  private collectionWith(collectionId: number) {
    return this.prisma.consolidatedCollection.findUnique({
      where: { id: collectionId },
      include: { group: { select: { id: true, name: true } } },
    });
  }

  /** "Fri 13 Nov" in the collection's own timezone. */
  private dayLabel(date: Date, timezone: string): string {
    return new Intl.DateTimeFormat('en-AU', {
      timeZone: timezone, weekday: 'short', day: 'numeric', month: 'short',
    }).format(date);
  }

  private minutesOf(instant: Date, timezone: string): number {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone, hour12: false, hour: '2-digit', minute: '2-digit',
    }).formatToParts(instant);
    const h = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
    const m = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
    return (h === 24 ? 0 : h) * 60 + m;
  }

  private window(start: Date, end: Date, timezone: string): string {
    return formatWindowRange(this.minutesOf(start, timezone), this.minutesOf(end, timezone));
  }

  // ─── Events ────────────────────────────────────────────────────────────────

  async collectionsScheduled(collectionIds: number[]): Promise<void> {
    for (const id of collectionIds) {
      const c = await this.collectionWith(id);
      if (!c) continue;
      await this.push(
        await this.siteStaffIds(c.participatingSiteIds),
        'Food collection scheduled',
        `Collection at ${c.pointName}, ${this.dayLabel(c.scheduledDate, c.timezone)}. ` +
          `List by ${this.window(c.submissionsCloseAt, c.submissionsCloseAt, c.timezone).split('–')[0]}.`,
        { type: CONSOLIDATED_PUSH.SCHEDULED, collectionId: String(id), groupId: String(c.groupId) },
      );
    }
  }

  async closingSoon(collectionId: number, siteIds: number[]): Promise<void> {
    const c = await this.collectionWith(collectionId);
    if (!c) return;
    await this.push(
      await this.siteStaffIds(siteIds),
      'Submissions close soon',
      `Add your food for ${c.pointName} before submissions close.`,
      { type: CONSOLIDATED_PUSH.CLOSING_SOON, collectionId: String(collectionId) },
      'high',
    );
  }

  async collectionClosed(collectionId: number): Promise<void> {
    const c = await this.collectionWith(collectionId);
    if (!c) return;
    await this.push(
      await this.groupMemberIds(c.groupId),
      'Submissions closed',
      `Submissions closed for ${c.pointName} on ${this.dayLabel(c.scheduledDate, c.timezone)}. ` +
        'Confirm what arrived, then publish.',
      { type: CONSOLIDATED_PUSH.CLOSED, collectionId: String(collectionId) },
    );
  }

  async remindSites(collectionId: number, siteIds: number[]): Promise<void> {
    const c = await this.collectionWith(collectionId);
    if (!c) return;
    await this.push(
      await this.siteStaffIds(siteIds),
      'Food collection reminder',
      `${c.group.name} is collecting at ${c.pointName} on ${this.dayLabel(c.scheduledDate, c.timezone)}.`,
      { type: CONSOLIDATED_PUSH.REMINDER, collectionId: String(collectionId) },
    );
  }

  async handoverOverdue(collectionId: number, siteIds: number[]): Promise<void> {
    const c = await this.collectionWith(collectionId);
    if (!c) return;
    await Promise.all([
      this.push(
        await this.groupMemberIds(c.groupId),
        'Handover overdue',
        `${siteIds.length} site(s) have not handed over for ${c.pointName}.`,
        { type: CONSOLIDATED_PUSH.OVERDUE, collectionId: String(collectionId) },
        'high',
      ),
      this.push(
        await this.siteStaffIds(siteIds),
        'Handover overdue',
        `Confirm your handover for ${c.pointName}.`,
        { type: CONSOLIDATED_PUSH.OVERDUE, collectionId: String(collectionId) },
        'high',
      ),
    ]);
  }

  async lateContribution(collectionId: number, siteName: string): Promise<void> {
    const c = await this.collectionWith(collectionId);
    if (!c) return;
    await this.push(
      await this.groupMemberIds(c.groupId, [ConsolidatedMemberRole.MANAGER]),
      'Late contribution',
      `${siteName} submitted after the deadline — review it.`,
      { type: CONSOLIDATED_PUSH.LATE_REQUEST, collectionId: String(collectionId) },
      'high',
    );
  }

  async lateDecided(contributionId: number, approved: boolean): Promise<void> {
    const contribution = await this.prisma.consolidatedContribution.findUnique({
      where: { id: contributionId },
      select: { siteId: true, collectionId: true },
    });
    if (!contribution) return;
    await this.push(
      await this.siteStaffIds([contribution.siteId]),
      approved ? 'Late contribution accepted' : 'Late contribution declined',
      approved
        ? 'Your food has been added to the collection.'
        : 'Your food was not added to this collection.',
      {
        type: CONSOLIDATED_PUSH.LATE_DECIDED,
        collectionId: String(contribution.collectionId),
        approved: String(approved),
      },
    );
  }

  async handoverConfirmed(collectionId: number, siteName: string): Promise<void> {
    const c = await this.collectionWith(collectionId);
    if (!c) return;
    await this.push(
      await this.groupMemberIds(c.groupId),
      'Food handed over',
      `${siteName} confirmed handover for ${c.pointName}.`,
      { type: CONSOLIDATED_PUSH.HANDOVER, collectionId: String(collectionId) },
    );
  }

  async receiptRecorded(contributionId: number, received: boolean): Promise<void> {
    const contribution = await this.prisma.consolidatedContribution.findUnique({
      where: { id: contributionId },
      select: { siteId: true, collectionId: true },
    });
    if (!contribution) return;
    await this.push(
      await this.siteStaffIds([contribution.siteId]),
      received ? 'Food received' : 'Food not received',
      received
        ? 'Your contribution was confirmed at the collection point.'
        : 'Your contribution was not received at the collection point.',
      { type: CONSOLIDATED_PUSH.RECEIPT, collectionId: String(contribution.collectionId) },
    );
  }

  async published(collectionId: number): Promise<void> {
    const c = await this.collectionWith(collectionId);
    if (!c) return;
    await this.push(
      await this.siteStaffIds(c.participatingSiteIds),
      'Collection published',
      `The food for ${c.pointName} is now available to charities.`,
      { type: CONSOLIDATED_PUSH.PUBLISHED, collectionId: String(collectionId) },
    );
  }

  async claimed(collectionId: number): Promise<void> {
    const c = await this.collectionWith(collectionId);
    if (!c) return;
    await Promise.all([
      this.push(
        await this.groupMemberIds(c.groupId),
        'Collection claimed',
        `A charity claimed the collection at ${c.pointName}.`,
        { type: CONSOLIDATED_PUSH.CLAIMED, collectionId: String(collectionId) },
      ),
      this.push(
        await this.siteStaffIds(c.participatingSiteIds),
        'Food claimed',
        `The food you contributed to ${c.pointName} has been claimed.`,
        { type: CONSOLIDATED_PUSH.CLAIMED, collectionId: String(collectionId) },
      ),
    ]);
  }

  /** Charity-facing: collection-point identity only, never outlet names. */
  async pickupSoon(collectionId: number, claimId: number): Promise<void> {
    const c = await this.collectionWith(collectionId);
    if (!c) return;
    await Promise.all([
      this.push(
        await this.charityUserIds(claimId),
        'Pickup starting soon',
        `Pickup at ${c.pointName}, ${this.window(c.pickupStartAt, c.pickupEndAt, c.timezone)}.`,
        { type: CONSOLIDATED_PUSH.PICKUP_SOON, collectionId: String(collectionId) },
        'high',
      ),
      this.push(
        await this.groupMemberIds(c.groupId, [ConsolidatedMemberRole.RECEIVER]),
        'Pickup starting soon',
        `The charity collects from ${c.pointName} shortly.`,
        { type: CONSOLIDATED_PUSH.PICKUP_SOON, collectionId: String(collectionId) },
      ),
    ]);
  }

  async changeRequested(collectionId: number, siteName: string): Promise<void> {
    const c = await this.collectionWith(collectionId);
    if (!c) return;
    await this.push(
      await this.groupMemberIds(c.groupId, [ConsolidatedMemberRole.MANAGER]),
      'Change requested',
      `${siteName} asked to change their contribution.`,
      { type: CONSOLIDATED_PUSH.CHANGE_REQUEST, collectionId: String(collectionId) },
      'high',
    );
  }

  /** The summary is written by diffMaterial and is already charity-safe. */
  async materialChange(collectionId: number, claimId: number, summary: string): Promise<void> {
    await this.push(
      await this.charityUserIds(claimId),
      'Collection details changed',
      summary,
      { type: CONSOLIDATED_PUSH.MATERIAL_CHANGE, collectionId: String(collectionId) },
      'high',
    );
  }

  async itemCheckDue(collectionId: number, claimId: number): Promise<void> {
    const c = await this.collectionWith(collectionId);
    if (!c) return;
    await Promise.all([
      this.push(
        await this.charityUserIds(claimId),
        'Confirm what you collected',
        'Record what you accepted so the food can be counted.',
        { type: CONSOLIDATED_PUSH.ITEM_CHECK_DUE, collectionId: String(collectionId) },
        'high',
      ),
      this.push(
        await this.groupMemberIds(c.groupId),
        'Collection not yet confirmed',
        `The charity has not confirmed what they collected from ${c.pointName}.`,
        { type: CONSOLIDATED_PUSH.ITEM_CHECK_DUE, collectionId: String(collectionId) },
      ),
    ]);
  }

  async completed(collectionId: number): Promise<void> {
    const c = await this.collectionWith(collectionId);
    if (!c) return;
    await this.push(
      await this.siteStaffIds(c.participatingSiteIds),
      'Collection complete',
      `Your impact from ${c.pointName} has been recorded.`,
      { type: CONSOLIDATED_PUSH.COMPLETED, collectionId: String(collectionId) },
    );
  }

  async collectionCancelled(collectionId: number, notifyCharity: boolean): Promise<void> {
    const c = await this.collectionWith(collectionId);
    if (!c) return;

    const body = `The collection at ${c.pointName} on ${this.dayLabel(c.scheduledDate, c.timezone)} was cancelled.`;
    const data = { type: CONSOLIDATED_PUSH.CANCELLED, collectionId: String(collectionId) };

    const targets: Promise<void>[] = [
      this.push(await this.siteStaffIds(c.participatingSiteIds), 'Collection cancelled', body, data, 'high'),
      this.push(await this.groupMemberIds(c.groupId), 'Collection cancelled', body, data),
    ];

    if (notifyCharity && c.masterListingId) {
      const claim = await this.prisma.foodClaim.findFirst({
        where: { listingId: c.masterListingId },
        orderBy: { createdAt: 'desc' },
        select: { id: true },
      });
      if (claim) {
        targets.push(
          this.push(await this.charityUserIds(claim.id), 'Collection cancelled', body, data, 'high'),
        );
      }
    }

    await Promise.all(targets);
  }

  async expired(collectionId: number): Promise<void> {
    const c = await this.collectionWith(collectionId);
    if (!c) return;
    await this.push(
      await this.groupMemberIds(c.groupId),
      'Collection expired',
      `Nobody collected the food at ${c.pointName} before the pickup window closed.`,
      { type: CONSOLIDATED_PUSH.CANCELLED, collectionId: String(collectionId) },
    );
  }
}
