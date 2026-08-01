import { ForbiddenException, HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { BillingCycle, SubscriptionStatus } from '@prisma/client';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { Jwtpayload } from '../../auth/interface/jwt.interface';
import {
  BILLING_ERROR,
  ENTITLING_STATUSES,
  FeatureKey,
  isFreeForever,
  requiresBilling,
} from '../subscription.constants';

export interface Entitlements {
  /** false for charities and farmer consumers — they are never gated */
  billingRequired: boolean;
  /** true when the org may perform write actions */
  entitled: boolean;
  status: SubscriptionStatus | null;
  planId: number | null;
  planName: string | null;
  planDisplayName: string | null;
  billingCycle: BillingCycle | null;
  /** Billed site count for per-site plans */
  quantity: number | null;
  /** null means unlimited */
  maxSites: number | null;
  /** null means unlimited */
  maxUserPerSite: number | null;
  /** PlanFeature.key values included in the plan */
  features: string[];
  trialEndsAt: Date | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  /** false once the org has consumed its one trial */
  freeTrialAvailable: boolean;
  /** Set while a downgrade is waiting for the period to close */
  pendingPlanId: number | null;
  pendingPlanDisplayName: string | null;
  pendingBillingCycle: BillingCycle | null;
  pendingChangeEffectiveAt: Date | null;
}

const UNLIMITED_FREE: Omit<Entitlements, 'billingRequired' | 'entitled'> = {
  status: null,
  planId: null,
  planName: null,
  planDisplayName: null,
  billingCycle: null,
  quantity: null,
  maxSites: null,
  maxUserPerSite: null,
  features: [],
  trialEndsAt: null,
  currentPeriodEnd: null,
  cancelAtPeriodEnd: false,
  freeTrialAvailable: false,
  pendingPlanId: null,
  pendingPlanDisplayName: null,
  pendingBillingCycle: null,
  pendingChangeEffectiveAt: null,
};

/**
 * Single source of truth for "what is this organisation allowed to do".
 *
 * Two distinct gates live here:
 *  - entitlement  — does the org have an active plan at all (blocks all writes)
 *  - plan limits  — does the active plan cover this site / user / feature
 */
@Injectable()
export class SubscriptionAccessService {
  constructor(private readonly prisma: PrismaService) {}

  async getEntitlements(caller: Jwtpayload): Promise<Entitlements> {
    // Charities and farmer consumers: free for life, no record, no limits.
    if (isFreeForever(caller.orgType)) {
      return { billingRequired: false, entitled: true, ...UNLIMITED_FREE };
    }

    if (!requiresBilling(caller.orgType) || !caller.orgId) {
      return { billingRequired: false, entitled: true, ...UNLIMITED_FREE };
    }

    const [sub, org] = await Promise.all([
      this.prisma.orgSubscription.findUnique({
        where: { organisationId: caller.orgId },
        include: {
          plan: {
            select: {
              id: true,
              name: true,
              displayName: true,
              maxSites: true,
              maxUserPerSite: true,
              planFeatures: { where: { included: true }, select: { key: true } },
            },
          },
          pendingPlan: { select: { displayName: true } },
        },
      }),
      this.prisma.organisation.findUnique({
        where: { id: caller.orgId },
        select: { freeTrialUsedAt: true },
      }),
    ]);

    const freeTrialAvailable = !org?.freeTrialUsedAt;

    if (!sub) {
      return {
        billingRequired: true,
        entitled: false,
        ...UNLIMITED_FREE,
        maxSites: 0,
        maxUserPerSite: 0,
        freeTrialAvailable,
      };
    }

    return {
      billingRequired: true,
      entitled: ENTITLING_STATUSES.includes(sub.status),
      status: sub.status,
      planId: sub.plan.id,
      planName: sub.plan.name,
      planDisplayName: sub.plan.displayName,
      billingCycle: sub.billingCycle,
      quantity: sub.quantity,
      maxSites: sub.plan.maxSites,
      maxUserPerSite: sub.plan.maxUserPerSite,
      features: sub.plan.planFeatures.map((f) => f.key),
      trialEndsAt: sub.trialEndsAt,
      currentPeriodEnd: sub.currentPeriodEnd,
      cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
      freeTrialAvailable,
      pendingPlanId: sub.pendingPlanId,
      pendingPlanDisplayName: sub.pendingPlan?.displayName ?? null,
      pendingBillingCycle: sub.pendingBillingCycle,
      pendingChangeEffectiveAt: sub.pendingChangeEffectiveAt,
    };
  }

  // ─── Gate 1: is there an active plan at all ────────────────────────────────

  /** Throws 402 when a billable org has no plan, or its plan has lapsed. */
  async assertEntitled(caller: Jwtpayload): Promise<Entitlements> {
    const ent = await this.getEntitlements(caller);
    if (!ent.billingRequired || ent.entitled) return ent;

    if (!ent.status) {
      throw new HttpException(
        {
          statusCode: HttpStatus.PAYMENT_REQUIRED,
          error: BILLING_ERROR.SUBSCRIPTION_REQUIRED,
          message: 'Please choose a plan to continue.',
        },
        HttpStatus.PAYMENT_REQUIRED,
      );
    }

    const reason =
      ent.status === SubscriptionStatus.PAST_DUE
        ? 'Your last payment failed. Please update your payment details to continue.'
        : `Your subscription is ${ent.status.toLowerCase()}. Please choose a plan to continue.`;

    throw new HttpException(
      {
        statusCode: HttpStatus.PAYMENT_REQUIRED,
        error: BILLING_ERROR.SUBSCRIPTION_INACTIVE,
        message: reason,
        status: ent.status,
      },
      HttpStatus.PAYMENT_REQUIRED,
    );
  }

  // ─── Gate 2: does the active plan cover this ───────────────────────────────

  /** Throws when adding another site would exceed the plan's site allowance. */
  async assertCanAddSite(caller: Jwtpayload): Promise<void> {
    const ent = await this.assertEntitled(caller);
    if (!ent.billingRequired || ent.maxSites === null) return; // unlimited

    const current = await this.prisma.site.count({
      where: { organisationId: caller.orgId },
    });

    if (current >= ent.maxSites) {
      throw new ForbiddenException({
        statusCode: HttpStatus.FORBIDDEN,
        error: BILLING_ERROR.SITE_LIMIT_REACHED,
        message:
          `Your ${ent.planDisplayName ?? 'current'} plan includes ${ent.maxSites} site(s) ` +
          `and you already have ${current}. Upgrade your plan to add more.`,
        limit: ent.maxSites,
        current,
      });
    }
  }

  /** Throws when adding another user to `siteId` would exceed the plan's seat allowance. */
  async assertCanAddUserToSite(caller: Jwtpayload, siteId: number): Promise<void> {
    const ent = await this.assertEntitled(caller);
    if (!ent.billingRequired || ent.maxUserPerSite === null) return; // unlimited

    const current = await this.prisma.siteAccess.count({ where: { siteId } });

    if (current >= ent.maxUserPerSite) {
      throw new ForbiddenException({
        statusCode: HttpStatus.FORBIDDEN,
        error: BILLING_ERROR.USER_LIMIT_REACHED,
        message:
          `Your ${ent.planDisplayName ?? 'current'} plan includes ${ent.maxUserPerSite} user(s) ` +
          `per site and this site already has ${current}. Upgrade your plan to add more.`,
        limit: ent.maxUserPerSite,
        current,
      });
    }
  }

  /** Throws when the plan does not include `feature`. */
  async assertFeature(caller: Jwtpayload, feature: FeatureKey): Promise<void> {
    const ent = await this.assertEntitled(caller);
    if (!ent.billingRequired) return;
    if (ent.features.includes(feature)) return;

    throw new ForbiddenException({
      statusCode: HttpStatus.FORBIDDEN,
      error: BILLING_ERROR.FEATURE_NOT_IN_PLAN,
      message: `Your ${ent.planDisplayName ?? 'current'} plan does not include this feature. Upgrade to unlock it.`,
      feature,
    });
  }

  /** Non-throwing variant for shaping responses. */
  async hasFeature(caller: Jwtpayload, feature: FeatureKey): Promise<boolean> {
    const ent = await this.getEntitlements(caller);
    if (!ent.billingRequired) return true;
    return ent.entitled && ent.features.includes(feature);
  }
}
