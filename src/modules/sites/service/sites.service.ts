import {
    BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { EnterpriseRole, OrgRole, OrgType, PlatformRole, Prisma, ScopeType, SiteRole } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { Jwtpayload } from '../../../modules/auth/interface/jwt.interface';
import { EmailQueueService } from '../../../modules/notifications/queues/email.queue.service';
import { BillingService } from '../../billing/services/billing.service';
import { SubscriptionAccessService } from '../../subscriptions/services/subscription-access.service';
import {
  AddStaffDto,
  AssignExistingSiteAdminDto,
  AssignSiteManagerDto,
  CreateSiteDto,
  UpdateSiteDto,
} from '../dto/sites.dto';

/**
 * SitesService
 *
 * Manages the full lifecycle of sites within an organisation — from creation
 * to staff management. A "site" is a physical location (branch, outlet, kitchen)
 * that belongs to a multi-site business organisation.
 *
 * Access rules at a glance:
 *  - SUPER_ADMIN  → full access across all sites in their org
 *  - SITE_ADMIN   → read/write access scoped to their assigned site only
 *  - STAFF        → read-only, scoped to their site
 */
@Injectable()
export class SitesService {
  private readonly logger = new Logger(SitesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly emailService: EmailQueueService,
    private readonly access: SubscriptionAccessService,
    private readonly billing: BillingService,
  ) {}

  // ─── Create Site ──────────────────────────────────────────────────────────────
  // Only SUPER_ADMINs of BUSINESS_MULTI orgs can add new sites.
  // Enforces the plan's maxSites cap before creation.

  /** Sites that belong to provisioned Enterprises only. */
  async listAllEnterpriseSites(caller: Jwtpayload) {
    if (caller.platformRole !== PlatformRole.PLATFORM_ADMIN) {
      throw new ForbiddenException('Platform admin access required');
    }

    const enterprises = await this.prisma.enterpriseProfile.findMany({
      select: { organisationId: true, enterpriseId: true },
    });
    const orgIds = enterprises.map((row) => row.organisationId);
    if (!orgIds.length) return { sites: [] };

    const [sites, organisations] = await Promise.all([
      this.prisma.site.findMany({
        where: { organisationId: { in: orgIds } },
        orderBy: [{ organisationId: 'asc' }, { createdAt: 'desc' }],
        include: {
          groupSite: { include: { group: { select: { id: true, name: true } } } },
          clusterSite: { include: { cluster: { select: { id: true, name: true } } } },
          territorySite: { include: { territory: { select: { id: true, name: true } } } },
        },
      }),
      this.prisma.organisation.findMany({
        where: { id: { in: orgIds } },
        select: { id: true, name: true },
      }),
    ]);
    if (!sites.length) return { sites: [] };

    const orgNameById = new Map(organisations.map((org) => [org.id, org.name]));
    const enterpriseIdByOrg = new Map(
      enterprises.map((row) => [row.organisationId, row.enterpriseId]),
    );

    return {
      sites: sites.map((site) => ({
        id: site.id,
        organisationId: site.organisationId,
        organisationName: orgNameById.get(site.organisationId) ?? site.organisationName,
        enterpriseId: enterpriseIdByOrg.get(site.organisationId) ?? null,
        siteName: site.name || site.organisationName,
        siteCode: site.siteCode || this.autoSiteCode(site.id),
        address: site.address,
        isActive: site.isActive,
        createdAt: site.createdAt,
        activatedAt: site.activatedAt,
        lastActivityAt: site.lastActivityAt,
        groupId: site.groupSite?.group.id ?? null,
        groupName: site.groupSite?.group.name ?? null,
        clusterId: site.clusterSite?.cluster.id ?? null,
        clusterName: site.clusterSite?.cluster.name ?? null,
        territoryId: site.territorySite?.territory.id ?? null,
        territoryName: site.territorySite?.territory.name ?? null,
      })),
    };
  }

  /**
   * Platform Admin creates a site under a chosen Enterprise. Entitlements and
   * structure checks run against that organisation, not the admin's own org.
   */
  async createSiteForOrganisation(
    caller: Jwtpayload,
    organisationId: number,
    dto: CreateSiteDto,
  ) {
    return this.createSite(
      await this.actingAsOrgAdmin(caller, organisationId),
      dto,
    );
  }

  async createSite(caller: Jwtpayload, dto: CreateSiteDto) {
    this.assertCanManageSites(caller);
    this.assertMultiBusiness(caller);

    const org = await this.prisma.organisation.findUnique({
      where: { id: caller.orgId },
    });
    if (!org) throw new NotFoundException('Organisation not found');

    // Platform Admin may onboard a site onto a new Enterprise before billing is live.
    if (caller.platformRole !== PlatformRole.PLATFORM_ADMIN) {
      await this.access.assertCanAddSite(caller);
    }
    const entitlements = await this.access.getEntitlements(caller);

    const existingSiteCount = await this.prisma.site.count({
      where: { organisationId: org.id },
    });

    const requestedCode = dto.siteCode?.trim() || null;
    if (requestedCode) {
      await this.assertSiteCodeFree(org.id, requestedCode);
    }
    await this.assertStructureTargets(org.id, dto);

    const now = new Date();
    let site;
    try {
      site = await this.prisma.site.create({
        data: {
          organisationId: org.id,
          organisationName: dto.siteName,
          name: dto.siteName,
          siteCode: requestedCode,
          address: dto.address,
          postcode: dto.postcode?.trim() || null,
          contactName: dto.contactName?.trim() || '',
          contactEmail: dto.contactEmail?.trim().toLowerCase() || '',
          contactMobile: dto.phoneNumber?.trim() || '',
          latitude: dto.latitude,
          longitude: dto.longitude,
          collectionDays: dto.collectionDays ?? [],
          collectionStartTime: dto.collectionStartTime ?? null,
          collectionEndTime: dto.collectionEndTime ?? null,
          collectionInstructions: dto.collectionInstructions?.trim() || null,
          activatedAt: now,
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException('That Site ID is already used in your organisation.');
      }
      throw err;
    }

    if (!site.siteCode) {
      site = await this.prisma.site.update({
        where: { id: site.id },
        data: { siteCode: this.autoSiteCode(site.id) },
      });
    }

    await this.placeSite(org.id, site.id, caller.sub, dto);

    this.logger.log(`Site created: id=${site.id} org=${org.id} by user=${caller.sub}`);

    // Per-site plans bill on location count, so Stripe has to hear about this.
    await this.billing.syncSiteQuantity(org.id);

    return {
      message: 'Site created successfully',
      site: await this.loadFormattedSite(site.id),
      sitesUsed: existingSiteCount + 1,
      sitesAllowed: entitlements.maxSites, // null means unlimited
    };
  }

  // ─── Organisation Overview ────────────────────────────────────────────────────
  // Returns a scoped snapshot of the org:
  //   SUPER_ADMIN  → full org info + all sites + all members grouped by site
  //   SITE_ADMIN   → only their assigned site + that site's staff list

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
      include: this.sitePlacementInclude(),
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

    // Group accesses by siteId for O(n) assembly instead of per-site DB calls
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
  // Full detail of a single site: metadata + managers + staff list.
  // Caller must either be SUPER_ADMIN or have access to that specific site.

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
  // SUPER_ADMIN gets all sites. SITE_ADMIN/STAFF gets only their assigned site.

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
  // SUPER_ADMIN only. Creates the user account if they don't exist yet,
  // then grants SITE_ADMIN access. Sends invite email for brand-new users.

  async assignSiteManager(caller: Jwtpayload, siteId: number, dto: AssignSiteManagerDto) {
    this.assertSuperAdmin(caller);

    const isAlreadyAssigned = await this.prisma.siteAccess.findFirst({
      where: {
        siteId,
        user: { email: dto.email.toLowerCase() },
      },
    });
    if (isAlreadyAssigned) {
      throw new BadRequestException('This user already has access for this site');
    }
    const site = await this.assertSiteInOrg(siteId, caller.orgId!);

    const org = await this.prisma.organisation.findUnique({
      where: { id: caller.orgId },
    });
    if (!org) throw new NotFoundException('Organisation not found');

    // Asserts an active plan, then that the plan's seat allowance has room.
    await this.access.assertCanAddUserToSite(caller, siteId);

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

    const updateSitedata = await this.prisma.site.update({
      where: {
        id:siteId
      },
      data: {
        contactName: dto.firstName + '' + dto.lastName,
        contactEmail: dto.email,
        contactMobile:dto.phoneNumber
      }
    })
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

  /**
   * Grants SITE_ADMIN on an existing org member. No password is created —
   * Super Admin invites new people through /enterprise/users instead.
   */
  async assignExistingSiteAdminForOrganisation(
    caller: Jwtpayload,
    organisationId: number,
    siteId: number,
    dto: AssignExistingSiteAdminDto,
  ) {
    return this.assignExistingSiteAdmin(
      await this.actingAsOrgAdmin(caller, organisationId),
      siteId,
      dto,
    );
  }

  async assignExistingSiteAdmin(
    caller: Jwtpayload,
    siteId: number,
    dto: AssignExistingSiteAdminDto,
  ) {
    this.assertCanManageSites(caller);

    const site = await this.assertSiteInOrg(siteId, caller.orgId!);
    const membership = await this.prisma.orgMemeberShip.findFirst({
      where: { userId: dto.userId, organisationId: caller.orgId },
      include: {
        user: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
            phoneNumber: true,
          },
        },
      },
    });
    if (!membership) {
      throw new NotFoundException('That user is not a member of your organisation');
    }

    if (caller.platformRole !== PlatformRole.PLATFORM_ADMIN) {
      await this.access.assertCanAddUserToSite(caller, siteId);
    }

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

    const existingScope = await this.prisma.userScope.findFirst({
      where: { userId: dto.userId, scopeType: ScopeType.SITE, scopeId: siteId },
    });
    if (!existingScope) {
      await this.prisma.userScope.create({
        data: {
          userId: dto.userId,
          organisationId: caller.orgId!,
          scopeType: ScopeType.SITE,
          scopeId: siteId,
          grantedBy: caller.sub,
        },
      });
    }

    const role = membership.enterpriseRole;
    if (!role || role === EnterpriseRole.SITE_USER) {
      await this.prisma.orgMemeberShip.update({
        where: { id: membership.id },
        data: { enterpriseRole: EnterpriseRole.SITE_ADMIN },
      });
    }

    const contactName = `${membership.user.firstName} ${membership.user.lastName}`.trim();
    if (!site.contactName?.trim()) {
      await this.prisma.site.update({
        where: { id: siteId },
        data: {
          contactName,
          contactEmail: membership.user.email,
          contactMobile: membership.user.phoneNumber ?? site.contactMobile,
        },
      });
    }

    this.logger.log(
      `Existing site admin assigned: userId=${dto.userId} siteId=${siteId} by=${caller.sub}`,
    );

    return {
      message: 'Existing user assigned as Site Admin.',
      siteAccess: {
        userId: access.userId,
        siteId: access.siteId,
        siteRole: access.siteRole,
        grantedAt: access.grantedAt,
      },
      user: membership.user,
    };
  }

  // ─── Add Staff ────────────────────────────────────────────────────────────────
  // SITE_ADMIN or SUPER_ADMIN can add staff to a site they manage.
  // Same findOrCreate pattern as assignSiteManager — upserts the SiteAccess row.

  async addStaff(caller: Jwtpayload, siteId: number, dto: AddStaffDto) {
    this.assertSiteAccess(caller, siteId);

    const site = await this.assertSiteInOrg(siteId, caller.orgId!);

    const org = await this.prisma.organisation.findUnique({
      where: { id: caller.orgId },
    });
    if (!org) throw new NotFoundException('Organisation not found');

    // Asserts an active plan, then that the plan's seat allowance has room.
    await this.access.assertCanAddUserToSite(caller, siteId);

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
  // Removes a user's SiteAccess record. If they have no remaining access to any
  // site in the org, their account is deactivated automatically.
  // Only SUPER_ADMINs can remove a SITE_ADMIN — staff can be removed by managers.

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

    // Deactivate user account if they no longer have access to any site in the org
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
  // Soft-deletes the site (isActive = false) and cleans up all SiteAccess rows.
  // Any user left with zero site accesses is also deactivated. All in one tx.

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
  // Partial update — only fields present in the DTO are written.
  // SUPER_ADMIN + BUSINESS_MULTI only.

  async updateSite(caller: Jwtpayload, siteId: number, dto: UpdateSiteDto) {
    this.assertCanEditSite(caller, siteId);
    this.assertMultiBusiness(caller);

    await this.assertSiteInOrg(siteId, caller.orgId!);
    if (dto.siteCode?.trim()) {
      await this.assertSiteCodeFree(caller.orgId!, dto.siteCode.trim(), siteId);
    }
    await this.assertStructureTargets(caller.orgId!, dto);

    let updated;
    try {
      updated = await this.prisma.site.update({
        where: { id: siteId },
        data: {
          ...(dto.siteName !== undefined && {
            organisationName: dto.siteName,
            name: dto.siteName,
          }),
          ...(dto.address !== undefined && { address: dto.address }),
          ...(dto.postcode !== undefined && { postcode: dto.postcode?.trim() || null }),
          ...(dto.siteCode !== undefined && { siteCode: dto.siteCode.trim() || null }),
          ...(dto.contactName !== undefined && { contactName: dto.contactName }),
          ...(dto.contactEmail !== undefined && { contactEmail: dto.contactEmail }),
          ...(dto.phoneNumber !== undefined && { contactMobile: dto.phoneNumber }),
          ...(dto.latitude !== undefined && { latitude: dto.latitude }),
          ...(dto.longitude !== undefined && { longitude: dto.longitude }),
          ...(dto.collectionDays !== undefined && { collectionDays: dto.collectionDays }),
          ...(dto.collectionStartTime !== undefined && {
            collectionStartTime: dto.collectionStartTime,
          }),
          ...(dto.collectionEndTime !== undefined && { collectionEndTime: dto.collectionEndTime }),
          ...(dto.collectionInstructions !== undefined && {
            collectionInstructions: dto.collectionInstructions?.trim() || null,
          }),
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException('That Site ID is already used in your organisation.');
      }
      throw err;
    }

    await this.placeSite(caller.orgId!, siteId, caller.sub, dto, true);

    this.logger.log(`Site updated: siteId=${siteId} org=${caller.orgId} by=${caller.sub}`);

    return { message: 'Site updated successfully', site: await this.loadFormattedSite(siteId) };
  }

  // ─── Private: Find or Create Org User ────────────────────────────────────────
  // Looks up the user by email. If they exist, ensures they belong to this org.
  // If not, creates the account + org membership in a single transaction and
  // returns isNewUser=true so the caller knows to send the invite email.

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

    // New user — hash password and create account + membership atomically
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

  private sitePlacementInclude() {
    return {
      groupSite: { select: { groupId: true } },
      clusterSite: { select: { clusterId: true } },
      territorySite: { select: { territoryId: true } },
    };
  }

  private async loadFormattedSite(siteId: number) {
    const site = await this.prisma.site.findUniqueOrThrow({
      where: { id: siteId },
      include: this.sitePlacementInclude(),
    });
    return this.formatSite(site);
  }

  /** Normalises the DB Site row into the public-facing shape. */
  private formatSite(s: {
    id: number;
    organisationName: string;
    name?: string | null;
    siteCode?: string | null;
    address: string;
    postcode: string | null;
    contactName: string;
    contactEmail: string;
    contactMobile: string;
    latitude: number | null;
    longitude: number | null;
    isActive: boolean;
    createdAt: Date;
    collectionDays?: string[];
    collectionStartTime?: string | null;
    collectionEndTime?: string | null;
    collectionInstructions?: string | null;
    groupSite?: { groupId: number } | null;
    clusterSite?: { clusterId: number } | null;
    territorySite?: { territoryId: number } | null;
  }) {
    const blank = (value?: string | null) =>
      !value || value === 'not provided' ? '' : value;
    return {
      id: s.id,
      siteName: s.name || s.organisationName,
      siteCode: s.siteCode || this.autoSiteCode(s.id),
      address: s.address,
      postcode: s.postcode,
      contactName: blank(s.contactName),
      contactEmail: blank(s.contactEmail),
      phoneNumber: blank(s.contactMobile),
      latitude: s.latitude,
      longitude: s.longitude,
      isActive: s.isActive,
      createdAt: s.createdAt,
      collectionDays: s.collectionDays ?? [],
      collectionStartTime: s.collectionStartTime ?? null,
      collectionEndTime: s.collectionEndTime ?? null,
      collectionInstructions: s.collectionInstructions ?? null,
      groupId: s.groupSite?.groupId ?? null,
      clusterId: s.clusterSite?.clusterId ?? null,
      territoryId: s.territorySite?.territoryId ?? null,
    };
  }

  private autoSiteCode(siteId: number) {
    return `SITE-${String(siteId).padStart(6, '0')}`;
  }

  private async assertSiteCodeFree(orgId: number, siteCode: string, excludeSiteId?: number) {
    const taken = await this.prisma.site.findFirst({
      where: {
        organisationId: orgId,
        siteCode,
        ...(excludeSiteId ? { id: { not: excludeSiteId } } : {}),
      },
      select: { id: true },
    });
    if (taken) {
      throw new ConflictException('That Site ID is already used in your organisation.');
    }
  }

  private async assertStructureTargets(
    orgId: number,
    dto: { groupId?: number | null; clusterId?: number | null; territoryId?: number | null },
  ) {
    if (dto.groupId) {
      const group = await this.prisma.enterpriseGroup.findFirst({
        where: { id: dto.groupId, organisationId: orgId },
        select: { id: true },
      });
      if (!group) throw new NotFoundException('Group not found');
    }
    if (dto.clusterId) {
      const cluster = await this.prisma.cluster.findFirst({
        where: { id: dto.clusterId, organisationId: orgId },
        select: { id: true },
      });
      if (!cluster) throw new NotFoundException('Cluster not found');
    }
    if (dto.territoryId) {
      const territory = await this.prisma.territory.findFirst({
        where: { id: dto.territoryId, organisationId: orgId },
        select: { id: true },
      });
      if (!territory) throw new NotFoundException('Territory not found');
    }
  }

  private async placeSite(
    orgId: number,
    siteId: number,
    actorId: number,
    dto: { groupId?: number | null; clusterId?: number | null; territoryId?: number | null },
    allowClear = false,
  ) {
    if (dto.groupId) {
      await this.prisma.groupSite.upsert({
        where: { siteId },
        create: { siteId, groupId: dto.groupId, organisationId: orgId, assignedBy: actorId },
        update: { groupId: dto.groupId, assignedBy: actorId, assignedAt: new Date() },
      });
    } else if (allowClear && dto.groupId === null) {
      await this.prisma.groupSite.deleteMany({ where: { siteId } });
    }

    if (dto.clusterId) {
      await this.prisma.clusterSite.upsert({
        where: { siteId },
        create: { siteId, clusterId: dto.clusterId, assignedBy: actorId },
        update: { clusterId: dto.clusterId, assignedBy: actorId, assignedAt: new Date() },
      });
    } else if (allowClear && dto.clusterId === null) {
      await this.prisma.clusterSite.deleteMany({ where: { siteId } });
    }

    if (dto.territoryId) {
      await this.prisma.territorySite.upsert({
        where: { siteId },
        create: { siteId, territoryId: dto.territoryId, assignedBy: actorId },
        update: { territoryId: dto.territoryId, assignedBy: actorId, assignedAt: new Date() },
      });
    } else if (allowClear && dto.territoryId === null) {
      await this.prisma.territorySite.deleteMany({ where: { siteId } });
    }
  }

  private async actingAsOrgAdmin(
    caller: Jwtpayload,
    organisationId: number,
  ): Promise<Jwtpayload> {
    if (caller.platformRole !== PlatformRole.PLATFORM_ADMIN) {
      throw new ForbiddenException('Platform admin access required');
    }
    const org = await this.prisma.organisation.findUnique({
      where: { id: organisationId },
    });
    if (!org) throw new NotFoundException('Organisation not found');
    return {
      ...caller,
      orgId: organisationId,
      orgType: org.organizationType,
      orgRole: OrgRole.SUPER_ADMIN,
      enterpriseRole: EnterpriseRole.SUPER_ADMIN,
    };
  }

  /** Super Admin or Enterprise Admin may add and assign sites. */
  private assertCanManageSites(caller: Jwtpayload) {
    if (caller.orgRole === OrgRole.SUPER_ADMIN) return;
    if (
      caller.enterpriseRole === EnterpriseRole.SUPER_ADMIN ||
      caller.enterpriseRole === EnterpriseRole.ENTERPRISE_ADMIN
    ) {
      return;
    }
    throw new ForbiddenException('Only an Enterprise Super Admin or Enterprise Admin can manage sites');
  }

  /** Super/Enterprise Admin, or the Site Admin of this site. */
  private assertCanEditSite(caller: Jwtpayload, siteId: number) {
    if (caller.orgRole === OrgRole.SUPER_ADMIN) return;
    if (
      caller.enterpriseRole === EnterpriseRole.SUPER_ADMIN ||
      caller.enterpriseRole === EnterpriseRole.ENTERPRISE_ADMIN
    ) {
      return;
    }
    this.assertSiteAccess(caller, siteId);
  }

  /** Throws 403 if caller is not a SUPER_ADMIN of their org. */
  private assertSuperAdmin(caller: Jwtpayload) {
    if (caller.orgRole !== OrgRole.SUPER_ADMIN) {
      throw new ForbiddenException('Only organisation super admins can perform this action');
    }
  }

  /** Throws 403 if the org is not a multi-site business (BUSINESS_MULTI). */
  private assertMultiBusiness(caller: Jwtpayload) {
    if (caller.orgType !== OrgType.BUSINESS_MULTI) {
      throw new ForbiddenException(
        'New sites can only be created for multi-site business organisations',
      );
    }
  }

  /**
   * Throws 403 if the caller does not have access to the given site.
   * SUPER_ADMIN bypasses this check — they can access any site in their org.
   */
  private assertSiteAccess(caller: Jwtpayload, siteId: number) {
     console.log("======== this is the test endpoint =============")
     console.log("siteId",siteId)
     console.log("caller siteId",caller.siteId)
     console.log("caller role",caller.siteRole)
    if (caller.orgRole === OrgRole.SUPER_ADMIN) return;
    if (caller.siteRole === SiteRole.SITE_ADMIN && caller.siteId === siteId) return;
    throw new ForbiddenException('You do not have access to this site');
  }

  /** Throws 404 if the site doesn't exist or doesn't belong to the org. */
  private async assertSiteInOrg(siteId: number, orgId: number) {
    const site = await this.prisma.site.findFirst({
      where: { id: siteId, organisationId: orgId },
    });
    if (!site) throw new NotFoundException('Site not found in your organisation');
    return site;
  }

}
