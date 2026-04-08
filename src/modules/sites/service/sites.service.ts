import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { OrgRole, OrgType, SiteRole, SubscriptionStatus } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { Jwtpayload } from 'src/modules/auth/interface/jwt.interface';
import { AddStaffDto, AssignSiteManagerDto, CreateSiteDto } from '../dto/sites.dto';

@Injectable()
export class SitesService {
  private readonly logger = new Logger(SitesService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ─── Create Site ──────────────────────────────────────────────────────────────

  async createSite(caller: Jwtpayload, dto: CreateSiteDto) {
    this.assertSuperAdmin(caller);
    this.assertMultiBusiness(caller);

    const org = await this.prisma.organisation.findUnique({
      where: { id: caller.orgId },
      include: { subscription: true },
    });
    if (!org) throw new NotFoundException('Organisation not found');

    this.assertActiveSubscription(org.subscriptionStatus);

    const existingSiteCount = await this.prisma.site.count({
      where: { organisationId: org.id },
    });

    const maxSites = org.subscription.maxSites;
    if (existingSiteCount >= maxSites) {
      throw new ForbiddenException(
        `Your subscription plan allows a maximum of ${maxSites} site(s). ` +
          `You currently have ${existingSiteCount}. Upgrade your plan to add more sites.`,
      );
    }

    const site = await this.prisma.site.create({
      data: {
        organisationId: org.id,
        organisationName: dto.siteName,
        address: dto.address,
        postcode: dto.postcode,
        contactName: dto.contactName,
        contactEmail: dto.contactEmail,
        contactMobile: dto.phoneNumber ?? '',
        latitude: dto.latitude,
        longitude: dto.longitude,
      },
    });

    this.logger.log(`Site created: id=${site.id} org=${org.id} by user=${caller.sub}`);

    return {
      message: 'Site created successfully',
      site: {
        id: site.id,
        siteName: site.organisationName,
        address: site.address,
        postcode: site.postcode,
        contactName: site.contactName,
        contactEmail: site.contactEmail,
        phoneNumber: site.contactMobile,
        latitude: site.latitude,
        longitude: site.longitude,
        isActive: site.isActive,
        createdAt: site.createdAt,
      },
      sitesUsed: existingSiteCount + 1,
      sitesAllowed: maxSites,
    };
  }

  // ─── List Sites ───────────────────────────────────────────────────────────────

  async listSites(caller: Jwtpayload) {
    if (caller.orgRole === OrgRole.SUPER_ADMIN) {
      const sites = await this.prisma.site.findMany({
        where: { organisationId: caller.orgId },
        orderBy: { createdAt: 'asc' },
      });
      return sites.map((s) => this.formatSite(s));
    }

    if (caller.siteId) {
      const site = await this.prisma.site.findFirst({
        where: { id: caller.siteId, organisationId: caller.orgId },
      });
      return site ? [this.formatSite(site)] : [];
    }

    return [];
  }

  // ─── Get Site ─────────────────────────────────────────────────────────────────

  async getSite(caller: Jwtpayload, siteId: number) {
    const site = await this.prisma.site.findFirst({
      where: { id: siteId, organisationId: caller.orgId },
    });
    if (!site) throw new NotFoundException('Site not found');
    this.assertSiteAccess(caller, siteId);
    return this.formatSite(site);
  }

  // ─── Assign Site Manager ──────────────────────────────────────────────────────

  async assignSiteManager(caller: Jwtpayload, siteId: number, dto: AssignSiteManagerDto) {
    this.assertSuperAdmin(caller);
    await this.assertSiteInOrg(siteId, caller.orgId!);
    await this.assertOrgMember(dto.userId, caller.orgId!);

    const org = await this.prisma.organisation.findUnique({
      where: { id: caller.orgId },
      include: { subscription: true },
    });
    if (!org) throw new NotFoundException('Organisation not found');

    this.assertActiveSubscription(org.subscriptionStatus);
    await this.assertUserLimitNotExceeded(siteId, org.subscription.maxUserPerSite);

    // Reactivate user in case they were previously deactivated
    await this.prisma.user.update({
      where: { id: dto.userId },
      data: { isActive: true },
    });

    const access = await this.prisma.siteAccess.upsert({
      where: { userId_siteId: { userId: dto.userId, siteId } },
      create: {
        userId: dto.userId,
        siteId,
        organisationId: caller.orgId!,
        siteRole: SiteRole.SITE_ADMIN,
        grantedBy: caller.sub,
      },
      update: {
        siteRole: SiteRole.SITE_ADMIN,
        grantedBy: caller.sub,
      },
    });

    this.logger.log(
      `Site manager assigned: userId=${dto.userId} siteId=${siteId} by super_admin=${caller.sub}`,
    );

    return {
      message: 'Site manager assigned successfully',
      siteAccess: {
        userId: access.userId,
        siteId: access.siteId,
        siteRole: access.siteRole,
        grantedAt: access.grantedAt,
      },
    };
  }

  // ─── Add Staff ────────────────────────────────────────────────────────────────

  async addStaff(caller: Jwtpayload, siteId: number, dto: AddStaffDto) {
    this.assertSiteAccess(caller, siteId);
    await this.assertSiteInOrg(siteId, caller.orgId!);
    await this.assertOrgMember(dto.userId, caller.orgId!);

    const org = await this.prisma.organisation.findUnique({
      where: { id: caller.orgId },
      include: { subscription: true },
    });
    if (!org) throw new NotFoundException('Organisation not found');

    this.assertActiveSubscription(org.subscriptionStatus);
    await this.assertUserLimitNotExceeded(siteId, org.subscription.maxUserPerSite);

    // Reactivate user in case they were previously deactivated
    await this.prisma.user.update({
      where: { id: dto.userId },
      data: { isActive: true },
    });

    const access = await this.prisma.siteAccess.upsert({
      where: { userId_siteId: { userId: dto.userId, siteId } },
      create: {
        userId: dto.userId,
        siteId,
        organisationId: caller.orgId!,
        siteRole: SiteRole.STAFF,
        grantedBy: caller.sub,
      },
      update: {
        siteRole: SiteRole.STAFF,
        grantedBy: caller.sub,
      },
    });

    this.logger.log(`Staff added: userId=${dto.userId} siteId=${siteId} by=${caller.sub}`);

    return {
      message: 'Staff member added successfully',
      siteAccess: {
        userId: access.userId,
        siteId: access.siteId,
        siteRole: access.siteRole,
        grantedAt: access.grantedAt,
      },
    };
  }

  // ─── List Staff ───────────────────────────────────────────────────────────────

  async listStaff(caller: Jwtpayload, siteId: number) {
    await this.assertSiteInOrg(siteId, caller.orgId!);
    this.assertSiteAccess(caller, siteId);

    const accesses = await this.prisma.siteAccess.findMany({
      where: { siteId, organisationId: caller.orgId },
      include: {
        user: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
            phoneNumber: true,
            isActive: true,
          },
        },
      },
      orderBy: { grantedAt: 'asc' },
    });

    return accesses.map((a) => ({
      userId: a.userId,
      siteRole: a.siteRole,
      grantedAt: a.grantedAt,
      user: a.user,
    }));
  }

  // ─── Remove Access ────────────────────────────────────────────────────────────

  async removeAccess(caller: Jwtpayload, siteId: number, targetUserId: number) {
    await this.assertSiteInOrg(siteId, caller.orgId!);
    this.assertSiteAccess(caller, siteId);

    const access = await this.prisma.siteAccess.findUnique({
      where: { userId_siteId: { userId: targetUserId, siteId } },
    });
    if (!access) throw new NotFoundException('This user does not have access to this site');

    // Site admins/managers cannot remove another site admin — only super admin can
    if (
      access.siteRole === SiteRole.SITE_ADMIN &&
      caller.orgRole !== OrgRole.SUPER_ADMIN
    ) {
      throw new ForbiddenException('Only super admins can remove a site manager');
    }

    // Remove the site access
    await this.prisma.siteAccess.delete({
      where: { userId_siteId: { userId: targetUserId, siteId } },
    });

    // Check if the user has any remaining site accesses in this organisation
    const remainingAccesses = await this.prisma.siteAccess.count({
      where: { userId: targetUserId, organisationId: caller.orgId },
    });

    // If no remaining accesses, deactivate the account — they cannot log in
    if (remainingAccesses === 0) {
      await this.prisma.user.update({
        where: { id: targetUserId },
        data: { isActive: false },
      });
      this.logger.log(
        `User deactivated (no remaining site access): userId=${targetUserId} org=${caller.orgId}`,
      );
    }

    this.logger.log(
      `Access removed: userId=${targetUserId} siteId=${siteId} by=${caller.sub}`,
    );

    return {
      message:
        remainingAccesses === 0
          ? 'Access removed. User account has been deactivated as they no longer have access to any site.'
          : 'Access removed from site.',
      userDeactivated: remainingAccesses === 0,
    };
  }

  // ─── Private Helpers ──────────────────────────────────────────────────────────

  private formatSite(s: {
    id: number;
    organisationName: string;
    address: string;
    postcode: string | null;
    contactName: string;
    contactEmail: string;
    contactMobile: string;
    latitude: number | null;
    longitude: number | null;
    isActive: boolean;
    createdAt: Date;
  }) {
    return {
      id: s.id,
      siteName: s.organisationName,
      address: s.address,
      postcode: s.postcode,
      contactName: s.contactName,
      contactEmail: s.contactEmail,
      phoneNumber: s.contactMobile,
      latitude: s.latitude,
      longitude: s.longitude,
      isActive: s.isActive,
      createdAt: s.createdAt,
    };
  }

  private assertSuperAdmin(caller: Jwtpayload) {
    if (caller.orgRole !== OrgRole.SUPER_ADMIN) {
      throw new ForbiddenException('Only organisation super admins can perform this action');
    }
  }

  private assertMultiBusiness(caller: Jwtpayload) {
    if (caller.orgType !== OrgType.BUSINESS_MULTI) {
      throw new ForbiddenException(
        'New sites can only be created for multi-site business organisations',
      );
    }
  }

  private assertActiveSubscription(status: SubscriptionStatus) {
    if (status === SubscriptionStatus.CANCELLED || status === SubscriptionStatus.EXPIRED) {
      throw new ForbiddenException(
        'Your subscription is no longer active. Please renew to manage sites.',
      );
    }
  }

  /**
   * SUPER_ADMIN can access any site in their org.
   * SITE_ADMIN can only access the site stored in their JWT.
   */
  private assertSiteAccess(caller: Jwtpayload, siteId: number) {
    if (caller.orgRole === OrgRole.SUPER_ADMIN) return;
    if (caller.siteRole === SiteRole.SITE_ADMIN && caller.siteId === siteId) return;
    throw new ForbiddenException('You do not have access to this site');
  }

  private async assertSiteInOrg(siteId: number, orgId: number) {
    const site = await this.prisma.site.findFirst({
      where: { id: siteId, organisationId: orgId },
    });
    if (!site) throw new NotFoundException('Site not found in your organisation');
    return site;
  }

  private async assertOrgMember(userId: number, orgId: number) {
    const membership = await this.prisma.orgMemeberShip.findFirst({
      where: { userId, organisationId: orgId },
    });
    if (!membership) {
      throw new ForbiddenException('Target user is not a member of your organisation');
    }
    return membership;
  }

  private async assertUserLimitNotExceeded(siteId: number, maxUsersPerSite: number) {
    const currentCount = await this.prisma.siteAccess.count({ where: { siteId } });
    if (currentCount >= maxUsersPerSite) {
      throw new ForbiddenException(
        `This site has reached the maximum of ${maxUsersPerSite} user(s) allowed by your subscription plan.`,
      );
    }
  }
}
