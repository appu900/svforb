import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { EnterpriseRole, OrgRole, SiteRole } from '@prisma/client';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { Jwtpayload } from '../../auth/interface/jwt.interface';
import { EnterpriseScopeService } from '../../enterprise/services/enterprise-scope.service';
import { isViewOnlyRole } from '../../enterprise/enterprise.permissions';
import { requiresBilling } from '../../subscriptions/subscription.constants';

/**
 * Who may see and change which food records.
 *
 * Reach is always resolved on the server to a set of site ids, and anything
 * outside it is a **404**, never a 403 — a 403 would confirm the record exists
 * and leak which sites another part of the business operates.
 */
@Injectable()
export class MfcAccessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: EnterpriseScopeService,
  ) {}

  /** Make Food Count is for businesses that produce food, not receivers. */
  private isBusiness(caller: Jwtpayload): boolean {
    return requiresBilling(caller.orgType);
  }

  /**
   * Sites the caller may read, or `null` for every site in the organisation.
   *
   * An empty array means "nothing", which is what a charity or farmer-consumer
   * gets — and what turns every `/mfc` route into a 404 for them.
   */
  async reachSiteIds(caller: Jwtpayload): Promise<number[] | null> {
    if (!caller.orgId || !this.isBusiness(caller)) return [];
    return this.scope.getAllowedSiteIds(caller);
  }

  /** True when `siteId` is inside the caller's reach. */
  async isSiteInReach(caller: Jwtpayload, siteId: number): Promise<boolean> {
    const reach = await this.reachSiteIds(caller);
    if (reach === null) {
      // Unrestricted within the organisation — but still only this organisation.
      const site = await this.prisma.site.findFirst({
        where: { id: siteId, organisationId: caller.orgId },
        select: { id: true },
      });
      return Boolean(site);
    }
    return reach.includes(siteId);
  }

  async assertSiteInReach(caller: Jwtpayload, siteId: number): Promise<void> {
    if (!(await this.isSiteInReach(caller, siteId))) {
      throw new NotFoundException('Site not found');
    }
  }

  /** Loads a record only if the caller may see it; otherwise 404. */
  async assertRecordInReach(caller: Jwtpayload, recordId: number) {
    const record = await this.prisma.foodRecord.findFirst({
      where: { id: recordId, organisationId: caller.orgId },
      select: { id: true, siteId: true, organisationId: true, status: true, version: true },
    });
    if (!record) throw new NotFoundException('Food record not found');
    await this.assertSiteInReach(caller, record.siteId);
    return record;
  }

  /**
   * Whether the caller may write records for this site.
   *
   * Writing needs hands-on access to the site: a site access row, or being the
   * owner of a business that does not use the Enterprise hierarchy at all —
   * otherwise a single-site owner could not record their own kitchen's food.
   * The Enterprise Super Admin runs the whole enterprise and may change any
   * site's records. A view-only enterprise role never writes, however senior.
   */
  async canEditSite(caller: Jwtpayload, siteId: number): Promise<boolean> {
    if (!(await this.isSiteInReach(caller, siteId))) return false;
    // The role as stored now (same source as reach), so a stale token never decides.
    // An organisation owner counts as Enterprise Super Admin, exactly as reach does.
    const role = (await this.scope.getEnterpriseRole(caller)) ?? caller.enterpriseRole ?? null;
    if (isViewOnlyRole(role)) return false;
    if (role === EnterpriseRole.ENTERPRISE_ADMIN) return false;
    if (role === EnterpriseRole.SUPER_ADMIN) return true;

    const access = await this.prisma.siteAccess.findUnique({
      where: { userId_siteId: { userId: caller.sub, siteId } },
      select: { siteRole: true },
    });
    if (access && access.siteRole !== SiteRole.DRIVER) return true;

    const isOrgAdmin =
      caller.orgRole === OrgRole.SUPER_ADMIN || caller.orgRole === OrgRole.ORG_ADMIN;
    if (!isOrgAdmin) return false;

    // Enterprise customers manage access deliberately, so an admin there needs
    // a real site access row. Everyone else's owner runs the sites themselves.
    return !(await this.scope.isEnterprise(caller.orgId!));
  }

  async assertCanEditSite(caller: Jwtpayload, siteId: number): Promise<void> {
    await this.assertSiteInReach(caller, siteId);
    if (!(await this.canEditSite(caller, siteId))) {
      throw new ForbiddenException(
        'You can view this site’s food records but not change them.',
      );
    }
  }

  /** Reading insights is the same question as having any reach at all. */
  async canReadInsights(caller: Jwtpayload): Promise<boolean> {
    const reach = await this.reachSiteIds(caller);
    return reach === null || reach.length > 0;
  }

  async assertCanReadInsights(caller: Jwtpayload): Promise<void> {
    if (!(await this.canReadInsights(caller))) {
      throw new NotFoundException('Cannot GET this resource');
    }
  }

  /**
   * Narrows a requested site filter to what the caller may actually see.
   *
   * Passing another territory's site id does not error — it simply returns
   * nothing for it, which is what keeps a filter from being used to probe.
   */
  async resolveSiteFilter(
    caller: Jwtpayload,
    requestedSiteIds?: number[],
  ): Promise<number[] | null> {
    const reach = await this.reachSiteIds(caller);
    if (!requestedSiteIds?.length) return reach;
    if (reach === null) {
      const sites = await this.prisma.site.findMany({
        where: { id: { in: requestedSiteIds }, organisationId: caller.orgId },
        select: { id: true },
      });
      return sites.map((s) => s.id);
    }
    const allowed = new Set(reach);
    return requestedSiteIds.filter((id) => allowed.has(id));
  }
}
