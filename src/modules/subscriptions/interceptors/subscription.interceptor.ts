import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PlatformRole } from '@prisma/client';
import { Observable } from 'rxjs';
import { Jwtpayload } from '../../auth/interface/jwt.interface';
import { SKIP_SUBSCRIPTION_CHECK } from '../decorators/skip-subscription-check.decorator';
import { SubscriptionAccessService } from '../services/subscription-access.service';
import { requiresBilling } from '../subscription.constants';

/** Reads never require a plan — an unsubscribed org keeps view-only access. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Global write gate. A billable org with no active plan gets 402 on every
 * mutating request, with the message "Please choose a plan to continue."
 *
 * This is an interceptor rather than a guard on purpose: global guards run
 * before controller-scoped ones, so JwtAuthGuard would not yet have populated
 * `request.user`. Interceptors run after all guards, so the JWT is available.
 *
 * Applied as an APP_INTERCEPTOR, so new controllers are covered by default —
 * opt out explicitly with @SkipSubscriptionCheck().
 */
@Injectable()
export class SubscriptionInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly access: SubscriptionAccessService,
  ) {}

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
    if (context.getType() !== 'http') return next.handle();

    const skip = this.reflector.getAllAndOverride<boolean>(SKIP_SUBSCRIPTION_CHECK, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (skip) return next.handle();

    const request = context.switchToHttp().getRequest();
    if (SAFE_METHODS.has(request.method)) return next.handle();

    // Unauthenticated routes are JwtAuthGuard's concern, not ours.
    const user: Jwtpayload | undefined = request.user;
    if (!user) return next.handle();

    if (user.platformRole === PlatformRole.PLATFORM_ADMIN) return next.handle();

    // Charities and farmer consumers are free for life.
    if (!requiresBilling(user.orgType)) return next.handle();

    await this.access.assertEntitled(user);
    return next.handle();
  }
}
