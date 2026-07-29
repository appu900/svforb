import { SetMetadata } from '@nestjs/common';

export const SKIP_SUBSCRIPTION_CHECK = 'skipSubscriptionCheck';

/**
 * Exempts a route (or a whole controller) from the global subscription gate.
 *
 * Use for anything an unsubscribed org must still reach — signing in, browsing
 * plans, starting checkout, or registering a device token.
 */
export const SkipSubscriptionCheck = () =>
  SetMetadata(SKIP_SUBSCRIPTION_CHECK, true);
