import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { OrgRole, OrgType, PlatformRole, SiteRole, SubscriptionStatus } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { Jwtpayload } from '../../../modules/auth/interface/jwt.interface';
import { EmailQueueService } from '../../../modules/notifications/queues/email.queue.service';
import { AddStaffDto, AssignSiteManagerDto, CreateSiteDto, UpdateSiteDto } from '../dto/sites.dto';

@Injectable()
export class SitesService {
  private readonly logger = new Logger(SitesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly emailService: EmailQueueService,
  ) {}

  // ─── Create Site ──────────────────────────────────────────────────────────────

  async createSite(caller: Jwtpayload, dto: CreateSiteDto) {
    this.assertSuperAdmin(caller);
    this.assertMultiBusiness(caller);

    const org = await this.prisma.organisation.findUnique({
      where: { id: caller.orgId },
      include: { subscription: { include: { plan: true } } },
    });
    if (!org) throw new NotFoundException('Organisation not found');

    this.assertActiveSubscription(org.subscription?.status);

    const existingSiteCount = await this.prisma.site.count({
      where: { organisationId: org.id },
    });

    const maxSites = org.subscription?.plan.maxSites ?? 0;
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
      site: this.formatSite(site),
      sitesUsed: existingSiteCount + 1,
      sitesAllowed: maxSites,
    };
  }

  // ─── Organisation Overview ────────────────────────────────────────────────────

  async getOrganisationOverview(caller: Jwtpayload) {
    const org = await this.prisma.organisation.findUnique({
      where: { id: caller.orgId },
      include: { subscription: { include: { plan: true } } },
    });
    if (!org) throw new NotFoundException('Organisation not found');

    // SITE_ADMIN — return only their site + its staff
    if (caller.orgRole !== OrgRole.SUPER_ADMIN) {
      if (!caller.siteId) throw new ForbiddenException('No site assigned to your account');

      const site = await this.prisma.site.findFirst({
        where: { id: caller.siteId, organisationId: org.id },
      });
      if (!site) throw new NotFoundException('Site not found');

      const staff = await this.prisma.siteAccess.findMany({
        where: { siteId: caller.siteId, organisationId: org.id },
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

      return {
        role: caller.siteRole,
        site: this.formatSite(site),
        staff: staff.map((a) => ({
          userId: a.userId,
          siteRole: a.siteRole,
          grantedAt: a.grantedAt,
          user: a.user,
        })),
      };
    }

    // SUPER_ADMIN — return full org + all sites with their members
    const sites = await this.prisma.site.findMany({
      where: { organisationId: org.id },
      orderBy: { createdAt: 'asc' },
    });

    const siteIds = sites.map((s) => s.id);

    const allAccesses = await this.prisma.siteAccess.findMany({
      where: { siteId: { in: siteIds }, organisationId: org.id },
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

    // Group accesses by siteId
    const accessBySite = new Map<number, typeof allAccesses>();
    for (const access of allAccesses) {
      const list = accessBySite.get(access.siteId) ?? [];
      list.push(access);
      accessBySite.set(access.siteId, list);
    }

    return {
      organisation: {
        id: org.id,
        name: org.name,
        type: org.organizationType,
        address: org.address,
        brandName: org.brandName,
        logoUrl: org.logoUrl,
        region: org.region,
        registrationNumber: org.registrationNumber,
        venueType: org.venueType,
        createdAt: org.createdAt,
      },
      subscription: {
        plan: org.subscription?.plan.displayName ?? null,
        status: org.subscription?.status ?? null,
        billingCycle: org.subscription?.billingCycle ?? null,
        maxSites: org.subscription?.plan.maxSites ?? null,
        maxUsersPerSite: org.subscription?.plan.maxUserPerSite ?? null,
        trialEndsAt: org.subscription?.trialEndsAt ?? null,
        currentPeriodEnd: org.subscription?.currentPeriodEnd ?? null,
      },
      totalSites: sites.length,
      sites: sites.map((s) => {
        const members = accessBySite.get(s.id) ?? [];
        return {
          ...this.formatSite(s),
          totalMembers: members.length,
          managers: members
            .filter((a) => a.siteRole === SiteRole.SITE_ADMIN)
            .map((a) => ({ userId: a.userId, siteRole: a.siteRole, grantedAt: a.grantedAt, user: a.user })),
          staff: members
            .filter((a) => a.siteRole === SiteRole.STAFF)
            .map((a) => ({ userId: a.userId, siteRole: a.siteRole, grantedAt: a.grantedAt, user: a.user })),
        };
      }),
    };
  }

  // ─── Site Details ─────────────────────────────────────────────────────────────

  async getSiteDetails(caller: Jwtpayload, siteId: number) {
    const site = await this.assertSiteInOrg(siteId, caller.orgId!);
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

    const managers = accesses.filter((a) => a.siteRole === SiteRole.SITE_ADMIN);
    const staff = accesses.filter((a) => a.siteRole === SiteRole.STAFF);

    return {
      site: this.formatSite(site),
      totalMembers: accesses.length,
      managers: managers.map((a) => ({
        userId: a.userId,
        siteRole: a.siteRole,
        grantedAt: a.grantedAt,
        user: a.user,
      })),
      staff: staff.map((a) => ({
        userId: a.userId,
        siteRole: a.siteRole,
        grantedAt: a.grantedAt,
        user: a.user,
      })),
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

    const site = await this.assertSiteInOrg(siteId, caller.orgId!);

    const org = await this.prisma.organisation.findUnique({
      where: { id: caller.orgId },
      include: { subscription: { include: { plan: true } } },
    });
    if (!org) throw new NotFoundException('Organisation not found');

    this.assertActiveSubscription(org.subscription?.status);
    await this.assertUserLimitNotExceeded(siteId, org.subscription?.plan.maxUserPerSite ?? 0);

    const { user, isNewUser } = await this.findOrCreateOrgUser(dto, caller.orgId!);

    const access = await this.prisma.siteAccess.upsert({
      where: { userId_siteId: { userId: user.id, siteId } },
      create: {
        userId: user.id,
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

    if (isNewUser) {
      await this.emailService.sendStaffInvite({
        to: dto.email,
        name: dto.firstName,
        email: dto.email,
        password: dto.password,
        siteName: site.organisationName,
        role: 'Site Manager',
      });
    }

    this.logger.log(
      `Site manager assigned: userId=${user.id} siteId=${siteId} by super_admin=${caller.sub}`,
    );

    return {
      message: isNewUser
        ? 'Site manager created and assigned. Login credentials sent via email.'
        : 'Existing user assigned as site manager.',
      siteAccess: {
        userId: access.userId,
        siteId: access.siteId,
        siteRole: access.siteRole,
        grantedAt: access.grantedAt,
      },
      user: {
        id: user.id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
      },
    };
  }

  // ─── Add Staff ────────────────────────────────────────────────────────────────

  async addStaff(caller: Jwtpayload, siteId: number, dto: AddStaffDto) {
    this.assertSiteAccess(caller, siteId);

    const site = await this.assertSiteInOrg(siteId, caller.orgId!);

    const org = await this.prisma.organisation.findUnique({
      where: { id: caller.orgId },
      include: { subscription: { include: { plan: true } } },
    });
    if (!org) throw new NotFoundException('Organisation not found');

    this.assertActiveSubscription(org.subscription?.status);
    await this.assertUserLimitNotExceeded(siteId, org.subscription?.plan.maxUserPerSite ?? 0);

    const { user, isNewUser } = await this.findOrCreateOrgUser(dto, caller.orgId!);

    const access = await this.prisma.siteAccess.upsert({
      where: { userId_siteId: { userId: user.id, siteId } },
      create: {
        userId: user.id,
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

    if (isNewUser) {
      await this.emailService.sendStaffInvite({
        to: dto.email,
        name: dto.firstName,
        email: dto.email,
        password: dto.password,
        siteName: site.organisationName,
        role: 'Staff',
      });
    }

    this.logger.log(`Staff added: userId=${user.id} siteId=${siteId} by=${caller.sub}`);

    return {
      message: isNewUser
        ? 'Staff member created and added. Login credentials sent via email.'
        : 'Existing user added as staff.',
      siteAccess: {
        userId: access.userId,
        siteId: access.siteId,
        siteRole: access.siteRole,
        grantedAt: access.grantedAt,
      },
      user: {
        id: user.id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
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

    if (
      access.siteRole === SiteRole.SITE_ADMIN &&
      caller.orgRole !== OrgRole.SUPER_ADMIN
    ) {
      throw new ForbiddenException('Only super admins can remove a site manager');
    }

    await this.prisma.siteAccess.delete({
      where: { userId_siteId: { userId: targetUserId, siteId } },
    });

    const remainingAccesses = await this.prisma.siteAccess.count({
      where: { userId: targetUserId, organisationId: caller.orgId },
    });

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

  // ─── Delete Site ──────────────────────────────────────────────────────────────

  async deleteSite(caller: Jwtpayload, siteId: number) {
    this.assertSuperAdmin(caller);
    this.assertMultiBusiness(caller);

    const site = await this.assertSiteInOrg(siteId, caller.orgId!);
    if (!site.isActive) throw new NotFoundException('Site not found');

    const accesses = await this.prisma.siteAccess.findMany({
      where: { siteId, organisationId: caller.orgId },
      select: { userId: true },
    });
    const affectedUserIds = accesses.map((a) => a.userId);

    await this.prisma.$transaction(async (tx) => {
      await tx.site.update({ where: { id: siteId }, data: { isActive: false } });
      await tx.siteAccess.deleteMany({ where: { siteId } });

      for (const userId of affectedUserIds) {
        const remaining = await tx.siteAccess.count({
          where: { userId, organisationId: caller.orgId },
        });
        if (remaining === 0) {
          await tx.user.update({ where: { id: userId }, data: { isActive: false } });
        }
      }
    });

    this.logger.log(`Site deactivated: siteId=${siteId} org=${caller.orgId} by=${caller.sub}`);

    return { message: 'Site deleted successfully', siteId };
  }

  // ─── Update Site ──────────────────────────────────────────────────────────────

  async updateSite(caller: Jwtpayload, siteId: number, dto: UpdateSiteDto) {
    this.assertSuperAdmin(caller);
    this.assertMultiBusiness(caller);

    await this.assertSiteInOrg(siteId, caller.orgId!);

    const updated = await this.prisma.site.update({
      where: { id: siteId },
      data: {
        ...(dto.siteName !== undefined && { organisationName: dto.siteName }),
        ...(dto.address !== undefined && { address: dto.address }),
        ...(dto.postcode !== undefined && { postcode: dto.postcode }),
        ...(dto.contactName !== undefined && { contactName: dto.contactName }),
        ...(dto.contactEmail !== undefined && { contactEmail: dto.contactEmail }),
        ...(dto.phoneNumber !== undefined && { contactMobile: dto.phoneNumber }),
        ...(dto.latitude !== undefined && { latitude: dto.latitude }),
        ...(dto.longitude !== undefined && { longitude: dto.longitude }),
      },
    });

    this.logger.log(`Site updated: siteId=${siteId} org=${caller.orgId} by=${caller.sub}`);

    return { message: 'Site updated successfully', site: this.formatSite(updated) };
  }

  // ─── Private: find existing user or create new one ────────────────────────────

  private async findOrCreateOrgUser(
    dto: { firstName: string; lastName: string; email: string; password: string; phoneNumber?: string },
    orgId: number,
  ): Promise<{ user: { id: number; firstName: string; lastName: string; email: string }; isNewUser: boolean }> {
    const existing = await this.prisma.user.findUnique({
      where: { email: dto.email.toLowerCase() },
    });

    if (existing) {
      // Ensure they belong to this org
      const membership = await this.prisma.orgMemeberShip.findFirst({
        where: { userId: existing.id, organisationId: orgId },
      });
      if (!membership) {
        throw new ConflictException(
          'A user with this email already exists but is not a member of your organisation',
        );
      }
      // Reactivate in case they were previously deactivated
      await this.prisma.user.update({
        where: { id: existing.id },
        data: { isActive: true },
      });
      return { user: existing, isNewUser: false };
    }

    // Create user + org membership in a transaction
    const passwordHash = await bcrypt.hash(dto.password, 10);

    const result = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          firstName: dto.firstName,
          lastName: dto.lastName,
          email: dto.email.toLowerCase(),
          passwordHash,
          phoneNumber: dto.phoneNumber ?? '',
          platformRole: PlatformRole.ORG_USER,
          emailVerified: true, // admin-created accounts skip email verification
          isActive: true,
        },
      });

      await tx.orgMemeberShip.create({
        data: {
          userId: user.id,
          organisationId: orgId,
          orgRole: OrgRole.ORG_MEMBER,
        },
      });

      return user;
    });

    return { user: result, isNewUser: true };
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

  private assertActiveSubscription(status: SubscriptionStatus | null | undefined) {
    if (
      !status ||
      status === SubscriptionStatus.CANCELLED ||
      status === SubscriptionStatus.EXPIRED
    ) {
      throw new ForbiddenException(
        'Your subscription is no longer active. Please renew to manage sites.',
      );
    }
  }

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

  private async assertUserLimitNotExceeded(siteId: number, maxUsersPerSite: number) {
    const currentCount = await this.prisma.siteAccess.count({ where: { siteId } });
    if (currentCount >= maxUsersPerSite) {
      throw new ForbiddenException(
        `This site has reached the maximum of ${maxUsersPerSite} user(s) allowed by your subscription plan.`,
      );
    }
  }
}
