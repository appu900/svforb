import { HttpException, HttpStatus } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { OrgType, PlatformRole } from '@prisma/client';
import { of } from 'rxjs';

import { REQUIRES_MODULE } from '../decorators/requires-module.decorator';
import { SKIP_SUBSCRIPTION_CHECK } from '../decorators/skip-subscription-check.decorator';
import { BILLING_ERROR } from '../subscription.constants';
import { SubscriptionInterceptor } from './subscription.interceptor';

/**
 * The global write gate with @RequiresModule. The access service is stubbed:
 * its module logic has its own spec.
 */
describe('SubscriptionInterceptor + @RequiresModule', () => {
  const moduleRequired = () =>
    new HttpException(
      { statusCode: HttpStatus.PAYMENT_REQUIRED, error: BILLING_ERROR.MODULE_REQUIRED, module: 'MFC' },
      HttpStatus.PAYMENT_REQUIRED,
    );

  function build(metadata: { module?: 'MFC' | 'CONNECT'; skip?: boolean }) {
    const reflector = {
      getAllAndOverride: jest.fn((key: string) => {
        if (key === REQUIRES_MODULE) return metadata.module;
        if (key === SKIP_SUBSCRIPTION_CHECK) return metadata.skip;
        return undefined;
      }),
    } as unknown as Reflector;
    const access = {
      assertEntitled: jest.fn().mockResolvedValue({}),
      // A Saveful Connect–only organisation.
      assertModule: jest.fn((_user: unknown, module: string) =>
        module === 'CONNECT' ? Promise.resolve({}) : Promise.reject(moduleRequired())),
    };
    return { interceptor: new SubscriptionInterceptor(reflector, access as never), access };
  }

  function context(method: string, user: Record<string, unknown> | undefined) {
    return {
      getType: () => 'http',
      getHandler: () => undefined,
      getClass: () => undefined,
      switchToHttp: () => ({ getRequest: () => ({ method, user }) }),
    } as never;
  }

  const next = { handle: () => of('ok') };
  const business = { sub: 1, orgId: 10, orgType: OrgType.BUSINESS_SINGLE, platformRole: PlatformRole.ORG_ADMIN };

  it('rejects a write on an MFC route for a Connect-only org with MODULE_REQUIRED', async () => {
    const { interceptor } = build({ module: 'MFC' });
    await expect(interceptor.intercept(context('POST', business), next)).rejects.toMatchObject({
      response: { error: BILLING_ERROR.MODULE_REQUIRED, module: 'MFC' },
    });
  });

  it('lets the same org write on a Connect route', async () => {
    const { interceptor, access } = build({ module: 'CONNECT' });
    await expect(interceptor.intercept(context('POST', business), next)).resolves.toBeDefined();
    expect(access.assertModule).toHaveBeenCalledWith(business, 'CONNECT');
    expect(access.assertEntitled).not.toHaveBeenCalled();
  });

  it('never gates reads by module', async () => {
    const { interceptor, access } = build({ module: 'MFC' });
    await expect(interceptor.intercept(context('GET', business), next)).resolves.toBeDefined();
    expect(access.assertModule).not.toHaveBeenCalled();
  });

  it('skips charities, which are never billed', async () => {
    const { interceptor, access } = build({ module: 'CONNECT' });
    const charity = { ...business, orgType: OrgType.CHARITY_SINGLE };
    await expect(interceptor.intercept(context('POST', charity), next)).resolves.toBeDefined();
    expect(access.assertModule).not.toHaveBeenCalled();
  });

  it('skips platform admins', async () => {
    const { interceptor, access } = build({ module: 'MFC' });
    const platformAdmin = { ...business, platformRole: PlatformRole.PLATFORM_ADMIN };
    await expect(interceptor.intercept(context('PATCH', platformAdmin), next)).resolves.toBeDefined();
    expect(access.assertModule).not.toHaveBeenCalled();
  });

  it('keeps the plain entitlement check on routes without a module', async () => {
    const { interceptor, access } = build({});
    await interceptor.intercept(context('DELETE', business), next);
    expect(access.assertEntitled).toHaveBeenCalledWith(business);
    expect(access.assertModule).not.toHaveBeenCalled();
  });

  it('honours @SkipSubscriptionCheck over @RequiresModule', async () => {
    const { interceptor, access } = build({ module: 'MFC', skip: true });
    await expect(interceptor.intercept(context('POST', business), next)).resolves.toBeDefined();
    expect(access.assertModule).not.toHaveBeenCalled();
  });
});
