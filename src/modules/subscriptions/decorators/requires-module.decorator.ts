import { SetMetadata } from '@nestjs/common';
import { ProductModule } from '../subscription.constants';

export const REQUIRES_MODULE = 'requiresModule';

/**
 * Restricts a route (or a whole controller) to orgs whose plan includes
 * `module`. Checked by the global SubscriptionInterceptor on writes only,
 * after the plain entitlement check — reads stay open so an org can still see
 * what it recorded before changing plan.
 */
export const RequiresModule = (module: ProductModule) => SetMetadata(REQUIRES_MODULE, module);
