import { EnterpriseRole, OrgRole, OrgType, SiteRole } from '@prisma/client';

import { MfcAccessService } from './mfc-access.service';

/**
 * Who may change a site's food records (canEditSite). Prisma and the
 * enterprise scope are stubbed, so this runs without a database.
 */
describe('MfcAccessService.canEditSite', () => {
  const SITE = 7;

  function build(options: {
    /** Role as stored on the membership (getEnterpriseRole). */
    storedRole?: EnterpriseRole | null;
    /** Site ids in reach; null = the whole organisation. */
    reach?: number[] | null;
    siteRole?: SiteRole | null;
    enterprise?: boolean;
  }) {
    const prisma = {
      site: { findFirst: jest.fn().mockResolvedValue({ id: SITE }) },
      siteAccess: {
        findUnique: jest.fn().mockResolvedValue(options.siteRole ? { siteRole: options.siteRole } : null),
      },
    };
    const scope = {
      getAllowedSiteIds: jest.fn().mockResolvedValue(options.reach === undefined ? null : options.reach),
      getEnterpriseRole: jest.fn().mockResolvedValue(options.storedRole ?? null),
      isEnterprise: jest.fn().mockResolvedValue(options.enterprise ?? true),
    };
    return new MfcAccessService(prisma as never, scope as never);
  }

  // A business organisation (requiresBilling) so the caller has reach at all.
  const caller = (extra: Record<string, unknown> = {}) =>
    ({ sub: 1, orgId: 10, orgType: OrgType.BUSINESS_MULTI, ...extra }) as never;

  it('lets the Enterprise Super Admin change any site, with no site access row', async () => {
    const service = build({ storedRole: EnterpriseRole.SUPER_ADMIN });
    await expect(service.canEditSite(caller(), SITE)).resolves.toBe(true);
  });

  it('trusts the stored role over a stale token', async () => {
    const service = build({ storedRole: EnterpriseRole.SUPER_ADMIN });
    await expect(service.canEditSite(caller({ enterpriseRole: EnterpriseRole.SITE_USER }), SITE)).resolves.toBe(true);
  });

  it('never lets the view-only Enterprise Admin change records', async () => {
    const service = build({ storedRole: EnterpriseRole.ENTERPRISE_ADMIN, siteRole: SiteRole.SITE_ADMIN });
    await expect(service.canEditSite(caller(), SITE)).resolves.toBe(false);
  });

  it('lets site staff change their own site', async () => {
    const service = build({ storedRole: EnterpriseRole.SITE_USER, reach: [SITE], siteRole: SiteRole.STAFF });
    await expect(service.canEditSite(caller(), SITE)).resolves.toBe(true);
  });

  it('does not let a driver change records', async () => {
    const service = build({ storedRole: EnterpriseRole.SITE_USER, reach: [SITE], siteRole: SiteRole.DRIVER });
    await expect(service.canEditSite(caller(), SITE)).resolves.toBe(false);
  });

  it('keeps an enterprise ORG_ADMIN without site access read only', async () => {
    const service = build({ storedRole: null, siteRole: null, enterprise: true });
    await expect(service.canEditSite(caller({ orgRole: OrgRole.ORG_ADMIN }), SITE)).resolves.toBe(false);
  });

  it('lets an ORG_ADMIN of a non-Enterprise business change every site', async () => {
    const service = build({ storedRole: null, siteRole: null, enterprise: false });
    await expect(service.canEditSite(caller({ orgRole: OrgRole.ORG_ADMIN }), SITE)).resolves.toBe(true);
  });

  it('refuses a site outside reach, even for a Super Admin', async () => {
    const service = build({ storedRole: EnterpriseRole.SUPER_ADMIN, reach: [99] });
    await expect(service.canEditSite(caller(), SITE)).resolves.toBe(false);
  });
});
