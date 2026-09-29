import { Injectable, Logger } from '@nestjs/common';
import { SiteRole } from '@prisma/client';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { NotificationService } from '../notifications/services/notification.service';
import {
  CHARITY_CONFIRM_MINUTES,
  describeSchedule,
  formatClock12,
  formatWindow,
  formatWindowRange,
  LIST_BY_MINUTES,
} from './connection.schedule';

/** Payload types the mobile apps switch on to pick a screen. */
export const CONNECTION_PUSH = {
  INVITATION: 'CONNECTION_INVITATION',
  ACCEPTED: 'CONNECTION_ACCEPTED',
  DECLINED: 'CONNECTION_DECLINED',
  DAILY_PROMPT: 'CONNECTION_DAILY_PROMPT',
  COLLECTION_READY: 'CONNECTION_COLLECTION_READY',
  CUTOFF_ESCALATION: 'CONNECTION_CUTOFF',
  RELEASED: 'CONNECTION_RELEASED',
  NO_SURPLUS: 'CONNECTION_NO_SURPLUS',
  NO_RESPONSE: 'CONNECTION_NO_RESPONSE',
  MOVED: 'CONNECTION_MOVED',
} as const;

/**
 * Every push this feature sends.
 *
 * Failures are logged and swallowed throughout: a collection that is agreed,
 * published or released must not be rolled back because a device token was
 * stale. The database is the record; the push is a nudge.
 */
@Injectable()
export class ConnectionNotifier {
  private readonly logger = new Logger(ConnectionNotifier.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationService,
  ) {}

  /** Staff who can actually see what is left in the kitchen. */
  private async siteStaffIds(siteId: number): Promise<number[]> {
    const access = await this.prisma.siteAccess.findMany({
      where: { siteId, siteRole: { in: [SiteRole.SITE_ADMIN, SiteRole.STAFF] } },
      select: { userId: true },
    });
    return [...new Set(access.map((a) => a.userId))];
  }

  /** Whoever administers the charity — an invitation is not a volunteer's call. */
  private async charityAdminIds(orgId: number, siteId: number): Promise<number[]> {
    const [members, siteAdmins] = await Promise.all([
      this.prisma.orgMemeberShip.findMany({
        where: { organisationId: orgId, orgRole: 'SUPER_ADMIN' },
        select: { userId: true },
      }),
      this.prisma.siteAccess.findMany({
        where: { siteId, siteRole: SiteRole.SITE_ADMIN },
        select: { userId: true },
      }),
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
      this.logger.error(
        `Push failed (${data.type}): ${(err as Error).message}`,
      );
    }
  }

  // ─── 1. Invitation ─────────────────────────────────────────────────────────

  async invitationSent(connection: {
    id: number;
    receiverOrgId: number;
    receiverSiteId: number;
    daysOfWeek: number[];
    windowStartMinutes: number;
    windowEndMinutes: number;
    typicalSurplus: string | null;
    typicalQuantity?: string | null;
    donorSite: { name: string | null; organisationName: string };
    donorOrg: { name: string };
  }): Promise<void> {
    const siteName = connection.donorSite.name ?? connection.donorSite.organisationName;
    const schedule = describeSchedule(
      connection.daysOfWeek, connection.windowStartMinutes, connection.windowEndMinutes,
    );

    await this.push(
      await this.charityAdminIds(connection.receiverOrgId, connection.receiverSiteId),
      'Regular collection invitation',
      `${connection.donorOrg.name} – ${siteName} would like to connect for regular surplus food collections. ${schedule}`,
      {
        type: CONNECTION_PUSH.INVITATION,
        connectionId: String(connection.id),
        schedule,
        ...(connection.typicalSurplus ? { typicalSurplus: connection.typicalSurplus } : {}),
        ...(connection.typicalQuantity ? { typicalQuantity: connection.typicalQuantity } : {}),
      },
      'high',
    );
  }

  async invitationAnswered(
    connection: { id: number; donorSiteId: number; receiverSite: { name: string | null; organisationName: string } },
    accepted: boolean,
  ): Promise<void> {
    const charity = connection.receiverSite.name ?? connection.receiverSite.organisationName;
    await this.push(
      await this.siteStaffIds(connection.donorSiteId),
      accepted ? 'Connection accepted' : 'Connection declined',
      accepted
        ? `${charity} accepted your regular collection. If today is a scheduled day and the window is still open, you can list surplus for them now.`
        : `${charity} declined your regular collection request.`,
      {
        type: accepted ? CONNECTION_PUSH.ACCEPTED : CONNECTION_PUSH.DECLINED,
        connectionId: String(connection.id),
      },
      'high',
    );
  }

  // ─── 2. Daily prompt to the business ───────────────────────────────────────

  async dailyPrompt(input: {
    connectionId: number;
    connectionDayId: number;
    donorSiteId: number;
    charityName: string;
    windowStartMinutes: number;
    windowEndMinutes: number;
    windowStartAt: Date;
    windowEndAt: Date;
    cutoffAt?: Date | null;
  }): Promise<void> {
    const window = formatWindowRange(input.windowStartMinutes, input.windowEndMinutes);
    const addByMinutes = input.windowStartMinutes - LIST_BY_MINUTES;
    const addBy = formatClock12(addByMinutes);
    await this.push(
      await this.siteStaffIds(input.donorSiteId),
      "Confirm today’s collection",
      `Your Connection with ${input.charityName} is scheduled for today between ${window}. Add the food and quantities available by ${addBy}.`,
      {
        type: CONNECTION_PUSH.DAILY_PROMPT,
        connectionId: String(input.connectionId),
        connectionDayId: String(input.connectionDayId),
        siteId: String(input.donorSiteId),
        charityName: input.charityName,
        windowStartAt: input.windowStartAt.toISOString(),
        windowEndAt: input.windowEndAt.toISOString(),
        ...(input.cutoffAt ? { cutoffAt: input.cutoffAt.toISOString() } : {}),
        categoryId: CONNECTION_PUSH.DAILY_PROMPT,
        action: 'ADD_SURPLUS',
        actionSecondary: 'NO_SURPLUS',
        cta: "Add today’s surplus",
        ctaSecondary: 'No surplus today',
      },
      'high',
    );
  }

  // ─── 3. Today's collection is ready ────────────────────────────────────────

  async collectionReady(input: {
    connectionId: number;
    connectionDayId?: number;
    listingId: number;
    receiverOrgId: number;
    receiverSiteId: number;
    donorName?: string;
    items: Array<{ name: string; quantityKg: number }>;
    windowStartMinutes: number;
    windowEndMinutes: number;
    /** ISO datetime by which the charity must confirm (1.5 hrs before pickup). */
    cutoffAt?: Date | null;
  }): Promise<void> {
    const window = formatWindowRange(input.windowStartMinutes, input.windowEndMinutes);
    const confirmBy = formatClock12(input.windowStartMinutes - CHARITY_CONFIRM_MINUTES);
    const itemLines = input.items
      .map((item) => `${item.quantityKg} kg ${item.name}`)
      .join('\n');
    const body = `${itemLines}\nPickup between ${window}\n\nPlease confirm by ${confirmBy}. If you can’t collect or don’t confirm by then, the food will be offered to nearby charities.`;

    await this.push(
      await this.charityAdminIds(input.receiverOrgId, input.receiverSiteId),
      'Today’s collection is ready',
      body,
      {
        type: CONNECTION_PUSH.COLLECTION_READY,
        connectionId: String(input.connectionId),
        listingId: String(input.listingId),
        ...(input.connectionDayId ? { connectionDayId: String(input.connectionDayId) } : {}),
        ...(input.donorName ? { donorName: input.donorName } : {}),
        categoryId: CONNECTION_PUSH.COLLECTION_READY,
        action: 'CONFIRM_COLLECTION',
        actionSecondary: 'CANNOT_COLLECT',
        actionTertiary: 'PAUSE',
        cta: 'Confirm Collection',
        ctaSecondary: 'Can’t collect today',
        ctaTertiary: 'Pause',
        ...(input.cutoffAt ? { cutoffAt: input.cutoffAt.toISOString() } : {}),
      },
      'high',
    );
  }

  /** Told rather than left waiting — a charity should not drive out for nothing. */
  async noSurplusToday(input: {
    connectionId: number;
    receiverOrgId: number;
    receiverSiteId: number;
    donorName: string;
  }): Promise<void> {
    await this.push(
      await this.charityAdminIds(input.receiverOrgId, input.receiverSiteId),
      'No collection today',
      `${input.donorName} has confirmed there is no surplus available today. Your regular Connection remains active for the next scheduled collection.`,
      { type: CONNECTION_PUSH.NO_SURPLUS, connectionId: String(input.connectionId) },
    );
  }

  /** Business stayed silent — the charity should not keep waiting. */
  async businessNoResponse(input: {
    connectionId: number;
    receiverOrgId: number;
    receiverSiteId: number;
    donorName: string;
  }): Promise<void> {
    await this.push(
      await this.charityAdminIds(input.receiverOrgId, input.receiverSiteId),
      'Today’s collection was not confirmed',
      `${input.donorName} did not confirm any surplus for today. No collection is required. Your regular Connection remains active.`,
      { type: CONNECTION_PUSH.NO_RESPONSE, connectionId: String(input.connectionId) },
    );
  }

  // ─── 4. Cut-off escalation ─────────────────────────────────────────────────

  async cutoffEscalation(input: {
    connectionId: number;
    connectionDayId: number;
    donorSiteId: number;
    listingId: number;
    charityName: string;
  }): Promise<void> {
    await this.push(
      await this.siteStaffIds(input.donorSiteId),
      'Collection not confirmed',
      `${input.charityName} has not confirmed today's collection. Offer it to other charities?`,
      {
        type: CONNECTION_PUSH.CUTOFF_ESCALATION,
        connectionId: String(input.connectionId),
        connectionDayId: String(input.connectionDayId),
        listingId: String(input.listingId),
        action: 'CONFIRM_RELEASE',
      },
      'high',
    );
  }


  async connectionPaused(input: {
    donorSiteId: number;
    charityName: string;
    connectionId: number;
  }): Promise<void> {
    await this.push(
      await this.siteStaffIds(input.donorSiteId),
      'Connection paused',
      `${input.charityName} has paused this Connection. You will not be prompted for regular collections until they resume it.`,
      {
        type: CONNECTION_PUSH.MOVED,
        connectionId: String(input.connectionId),
        action: 'VIEW_CONNECTION',
      },
    );
  }

  async reservationMoved(input: {
    connectionId: number;
    receiverOrgId: number;
    receiverSiteId: number;
    donorName: string;
  }): Promise<void> {
    await this.push(
      await this.charityAdminIds(input.receiverOrgId, input.receiverSiteId),
      'Collection offered elsewhere',
      `${input.donorName} has released today’s reserved collection.`,
      { type: CONNECTION_PUSH.MOVED, connectionId: String(input.connectionId) },
    );
  }

    async releasedToNetwork(input: {
    connectionId: number;
    donorSiteId: number;
    listingId: number;
    reason: string;
  }): Promise<void> {
    await this.push(
      await this.siteStaffIds(input.donorSiteId),
      'Released to the network',
      "Today's surplus is now available to nearby charities.",
      {
        type: CONNECTION_PUSH.RELEASED,
        connectionId: String(input.connectionId),
        listingId: String(input.listingId),
        reason: input.reason,
      },
    );
  }
}
