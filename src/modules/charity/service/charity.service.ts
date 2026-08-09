import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { OrgRole, OrgType, PlatformRole, SiteRole } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { Jwtpayload } from '../../../modules/auth/interface/jwt.interface';
import { EmailQueueService } from '../../../modules/notifications/queues/email.queue.service';
import {
  AddCharityLocationDto,
  AddCharityMemberDto,
  CharityMemberRole,
  UpdateCharityLocationDto,
  UpdateCharityMemberDto,
} from '../dto/charity.dto';
import { CharityCacheManager } from '../cache/charity.cache.manager';
import { ProximityService } from '../../../modules/psearch/psearch.service';
import { RedisGeoSearchService } from '../../../modules/redis-geo-search/redis.geosearch.service';

const CHARITY_ORG_TYPES: OrgType[] = [
  OrgType.CHARITY,
  OrgType.CHARITY_SINGLE,
  OrgType.CHARITY_MULTI,
];

@Injectable()
export class CharityService {
  private readonly logger = new Logger(CharityService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly emailService: EmailQueueService,
    private readonly cache: CharityCacheManager,
    private readonly proximityService: ProximityService,
    private readonly geoSearch: RedisGeoSearchService,
  ) {}

  async addLocation(caller: Jwtpayload, dto: AddCharityLocationDto) {
    this.assertSuperAdmin(caller);
    this.assertMultiCharity(caller);

    const org = await this.prisma.organisation.findUnique({
      where: { id: caller.orgId },
    });
    if (!org) throw new NotFoundException('Organisation not found');

    const existingUser = await this.prisma.user.findUnique({
      where: { email: dto.adminEmail.toLowerCase() },
    });

    if (existingUser) {
      const membership = await this.prisma.orgMemeberShip.findFirst({
        where: { userId: existingUser.id },
      });
      if (membership && membership.organisationId !== caller.orgId) {
        throw new ConflictException(
          'This email is registered with another organisation',
        );
      }
    }

    const nameParts = dto.adminContactName.trim().split(' ');
    const adminFirstName = nameParts[0];
    const adminLastName = nameParts.slice(1).join(' ') || adminFirstName;

    const result = await this.prisma.$transaction(async (tx) => {
      const site = await tx.site.create({
        data: {
          organisationId: caller.orgId!,
          organisationName: dto.locationName,
          address: dto.address,
          postcode: dto.postcode,
          contactName: dto.adminContactName,
          contactEmail: dto.adminEmail.toLowerCase(),
          contactMobile: dto.adminMobile,
          latitude: dto.latitude,
          longitude: dto.longitude,
          pickupRadiusKm: dto.radiusKm ?? 5,
        },
      });

      let adminUser = existingUser;
      let isNewAdmin = false;

      if (!adminUser) {
        const passwordHash = await bcrypt.hash(dto.adminPassword, 10);
        adminUser = await tx.user.create({
          data: {
            firstName: adminFirstName,
            lastName: adminLastName,
            email: dto.adminEmail.toLowerCase(),
            passwordHash,
            phoneNumber: dto.adminMobile,
            platformRole: PlatformRole.ORG_USER,
            emailVerified: true,
            isActive: true,
          },
        });

        await tx.orgMemeberShip.create({
          data: {
            userId: adminUser.id,
            organisationId: caller.orgId!,
            orgRole: OrgRole.ORG_MEMBER,
          },
        });

        isNewAdmin = true;
      } else {
        await tx.orgMemeberShip.upsert({
          where: {
            userId_organisationId: {
              userId: adminUser.id,
              organisationId: caller.orgId!,
            },
          },
          create: {
            userId: adminUser.id,
            organisationId: caller.orgId!,
            orgRole: OrgRole.ORG_MEMBER,
          },
          update: {},
        });
      }

      await tx.siteAccess.upsert({
        where: { userId_siteId: { userId: adminUser.id, siteId: site.id } },
        create: {
          userId: adminUser.id,
          siteId: site.id,
          organisationId: caller.orgId!,
          siteRole: SiteRole.SITE_ADMIN,
          grantedBy: caller.sub,
        },
        update: { siteRole: SiteRole.SITE_ADMIN, grantedBy: caller.sub },
      });

      return { site, adminUser, isNewAdmin };
    });

    if (dto.latitude != null && dto.longitude != null) {
      try {
        await this.proximityService.syncSiteLocation(
          result.site.id,
          dto.latitude,
          dto.longitude,
        );
      } catch (error) {
        this.logger.error(
          `Failed to sync PostGIS location for charity site=${result.site.id}`,
          error instanceof Error ? error.stack : undefined,
        );
      }

      if (org.region) {
        try {
          await this.geoSearch.indexCharitySite(
            result.site.id,
            dto.latitude,
            dto.longitude,
            org.region,
          );
        } catch (error) {
          this.logger.error(
            `Failed to index charity site=${result.site.id} in redis geo`,
            error instanceof Error ? error.stack : undefined,
          );
        }
      }
    }

    try {
      await this.emailService.sendStaffInvite({
        to: dto.adminEmail,
        name: adminFirstName,
        email: dto.adminEmail,
        password: dto.adminPassword,
        siteName: dto.locationName,
        role: 'Location Admin',
      });
    } catch (error) {
      this.logger.error(
        `Failed to queue staff invite for charity site=${result.site.id}`,
        error instanceof Error ? error.stack : undefined,
      );
    }

    await this.cache.invalidateLocations(caller.orgId!);
    await this.cache.invalidateUsers(caller.orgId!);
    await this.cache.invalidateLocation(result.site.id);

    this.logger.log(
      `Charity location added: siteId=${result.site.id} org=${caller.orgId} by=${caller.sub}`,
    );

    return {
      message: 'Location added successfully. Admin notified via email.',
      location: this.formatLocation(result.site),
      admin: {
        id: result.adminUser.id,
        name: `${result.adminUser.firstName} ${result.adminUser.lastName}`,
        email: result.adminUser.email,
        isNewUser: result.isNewAdmin,
      },
    };
  }

  // ** list all locations for a organizations
  async listLocations(caller: Jwtpayload) {
    this.assertCharityOrg(caller);

    const cached = await this.cache.getLocations<any[]>(caller.orgId!);
    if (cached) return cached;

    let sites: any[];

    if (caller.orgRole === OrgRole.SUPER_ADMIN) {
      sites = await this.prisma.site.findMany({
        where: { organisationId: caller.orgId },
        orderBy: { createdAt: 'asc' },
      });
    } else {
      if (!caller.siteId)
        throw new ForbiddenException('No location assigned to your account');
      const site = await this.prisma.site.findFirst({
        where: { id: caller.siteId, organisationId: caller.orgId },
      });
      sites = site ? [site] : [];
    }

    const result = sites.map((s) => this.formatLocation(s));
    await this.cache.setLocations(caller.orgId!, result);
    return result;
  }

  async getLocation(caller: Jwtpayload, locationId: number) {
    this.assertCharityOrg(caller);
    this.assertLocationAccess(caller, locationId);

    const cached = await this.cache.getLocation<any>(locationId);
    if (cached) return cached;

    const site = await this.prisma.site.findFirst({
      where: { id: locationId, organisationId: caller.orgId },
    });
    if (!site) throw new NotFoundException('Location not found');

    const accesses = await this.prisma.siteAccess.findMany({
      where: { siteId: locationId, organisationId: caller.orgId },
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

    const result = {
      location: this.formatLocation(site),
      totalMembers: accesses.length,
      admins: accesses
        .filter((a) => a.siteRole === SiteRole.SITE_ADMIN)
        .map((a) => ({
          userId: a.userId,
          role: 'LOCATION_ADMIN',
          grantedAt: a.grantedAt,
          user: a.user,
        })),
      teamMembers: accesses
        .filter((a) => a.siteRole === SiteRole.STAFF)
        .map((a) => ({
          userId: a.userId,
          role: 'TEAM_MEMBER',
          grantedAt: a.grantedAt,
          user: a.user,
        })),
      drivers: accesses
        .filter((a) => a.siteRole === SiteRole.DRIVER)
        .map((a) => ({
          userId: a.userId,
          role: 'DRIVER',
          canClaimPickupsDirectly: a.canClaimPickupsDirectly,
          grantedAt: a.grantedAt,
          user: a.user,
        })),
    };

    await this.cache.setLocation(locationId, result);
    return result;
  }

  async updateLocation(
    caller: Jwtpayload,
    locationId: number,
    dto: UpdateCharityLocationDto,
  ) {
    this.assertSuperAdmin(caller);
    this.assertCharityOrg(caller);

    const site = await this.prisma.site.findFirst({
      where: { id: locationId, organisationId: caller.orgId },
    });
    if (!site) throw new NotFoundException('Location not found');

    const radiusKm = dto.radiusKm ?? dto.pickupRadiusKm;

    const updated = await this.prisma.site.update({
      where: { id: locationId },
      data: {
        ...(dto.locationName && { organisationName: dto.locationName }),
        ...(dto.address && { address: dto.address }),
        ...(dto.postcode !== undefined && { postcode: dto.postcode }),
        ...(dto.contactName && { contactName: dto.contactName }),
        ...(dto.contactEmail && { contactEmail: dto.contactEmail }),
        ...(dto.contactMobile && { contactMobile: dto.contactMobile }),
        ...(radiusKm !== undefined && { pickupRadiusKm: radiusKm }),
        ...(dto.latitude !== undefined && { latitude: dto.latitude }),
        ...(dto.longitude !== undefined && { longitude: dto.longitude }),
      },
    });

    if (dto.latitude != null && dto.longitude != null) {
      try {
        await this.proximityService.syncSiteLocation(
          locationId,
          dto.latitude,
          dto.longitude,
        );
      } catch (error) {
        this.logger.error(
          `Failed to sync PostGIS location for charity site=${locationId}`,
          error instanceof Error ? error.stack : undefined,
        );
      }

      const org = await this.prisma.organisation.findUnique({
        where: { id: caller.orgId! },
        select: { region: true },
      });
      if (org?.region) {
        try {
          await this.geoSearch.indexCharitySite(
            locationId,
            dto.latitude,
            dto.longitude,
            org.region,
          );
        } catch (error) {
          this.logger.error(
            `Failed to index charity site=${locationId} in redis geo`,
            error instanceof Error ? error.stack : undefined,
          );
        }
      }
    }

    await this.cache.invalidateLocation(locationId);
    await this.cache.invalidateLocations(caller.orgId!);

    return {
      message: 'Location updated successfully',
      location: this.formatLocation(updated),
    };
  }

  async deactivateLocation(caller: Jwtpayload, locationId: number) {
    this.assertSuperAdmin(caller);
    this.assertCharityOrg(caller);

    const site = await this.prisma.site.findFirst({
      where: { id: locationId, organisationId: caller.orgId },
    });
    if (!site) throw new NotFoundException('Location not found');

    const activeCount = await this.prisma.site.count({
      where: { organisationId: caller.orgId, isActive: true },
    });
    if (site.isActive && activeCount <= 1) {
      throw new BadRequestException(
        'Cannot remove your only active site. Add another location first, or restore an inactive one.',
      );
    }

    // Never soft-delete the org's original (oldest) HQ site — rename it instead.
    const oldest = await this.prisma.site.findFirst({
      where: { organisationId: caller.orgId },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    if (oldest?.id === locationId) {
      throw new BadRequestException(
        'Cannot remove the default head-office site. You can rename it, but it must stay in your organisation.',
      );
    }

    await this.prisma.site.update({
      where: { id: locationId },
      data: { isActive: false },
    });

    const org = await this.prisma.organisation.findUnique({
      where: { id: caller.orgId! },
      select: { region: true },
    });
    if (org?.region) {
      await this.geoSearch.removeCharitySite(locationId, org.region);
    }

    await this.cache.invalidateLocation(locationId);
    await this.cache.invalidateLocations(caller.orgId!);

    return { message: 'Location deactivated successfully' };
  }

  async reactivateLocation(caller: Jwtpayload, locationId: number) {
    this.assertSuperAdmin(caller);
    this.assertCharityOrg(caller);

    const site = await this.prisma.site.findFirst({
      where: { id: locationId, organisationId: caller.orgId },
    });
    if (!site) throw new NotFoundException('Location not found');
    if (site.isActive) {
      return {
        message: 'Location is already active',
        location: this.formatLocation(site),
      };
    }

    const updated = await this.prisma.site.update({
      where: { id: locationId },
      data: { isActive: true },
    });

    const org = await this.prisma.organisation.findUnique({
      where: { id: caller.orgId! },
      select: { region: true },
    });
    if (
      org?.region &&
      updated.latitude != null &&
      updated.longitude != null
    ) {
      await this.geoSearch.indexCharitySite(
        updated.id,
        updated.latitude,
        updated.longitude,
        org.region,
      );
    }

    await this.cache.invalidateLocation(locationId);
    await this.cache.invalidateLocations(caller.orgId!);

    return {
      message: 'Location restored successfully',
      location: this.formatLocation(updated),
    };
  }

  async addMember(caller: Jwtpayload, dto: AddCharityMemberDto) {
    this.assertCharityOrg(caller);

    const locationRoles: CharityMemberRole[] = [
      CharityMemberRole.LOCATION_ADMIN,
      CharityMemberRole.TEAM_MEMBER,
      CharityMemberRole.DRIVER,
    ];

    // Only SUPER_ADMIN can add head-office or location-admin roles
    if (
      dto.role === CharityMemberRole.HEAD_OFFICE_ADMIN ||
      dto.role === CharityMemberRole.HEAD_OFFICE ||
      dto.role === CharityMemberRole.LOCATION_ADMIN
    ) {
      this.assertSuperAdmin(caller);
    }

    // SITE_ADMIN can only add TEAM_MEMBER or DRIVER to their own location
    if (
      caller.orgRole !== OrgRole.SUPER_ADMIN &&
      !locationRoles.includes(dto.role)
    ) {
      throw new ForbiddenException(
        'You do not have permission to add this role',
      );
    }

    if (locationRoles.includes(dto.role) && !dto.locationId) {
      if (caller.orgType === OrgType.CHARITY_SINGLE && caller.siteId) {
        dto.locationId = caller.siteId;
      } else {
        throw new BadRequestException(
          'locationId is required for location-based roles',
        );
      }
    }

    if (
      caller.orgRole !== OrgRole.SUPER_ADMIN &&
      dto.locationId &&
      caller.siteId !== dto.locationId
    ) {
      throw new ForbiddenException(
        'You can only add members to your own location',
      );
    }

    let site: any = null;
    if (dto.locationId) {
      site = await this.prisma.site.findFirst({
        where: { id: dto.locationId, organisationId: caller.orgId },
      });
      if (!site) throw new NotFoundException('Location not found');
    }

    const existingUser = await this.prisma.user.findUnique({
      where: { email: dto.email.toLowerCase() },
    });

    if (existingUser) {
      const membership = await this.prisma.orgMemeberShip.findFirst({
        where: { userId: existingUser.id, organisationId: caller.orgId },
      });
      if (!membership) {
        throw new ConflictException(
          'This email is already registered and does not belong to your organisation',
        );
      }
    }

    const { orgRole, siteRole } = this.mapCharityRole(dto.role);

    const result = await this.prisma.$transaction(async (tx) => {
      let user = existingUser;
      let isNewUser = false;

      if (!user) {
        const passwordHash = await bcrypt.hash(dto.password, 10);
        user = await tx.user.create({
          data: {
            firstName: dto.firstName,
            lastName: dto.lastName,
            email: dto.email.toLowerCase(),
            passwordHash,
            phoneNumber: dto.mobile ?? '',
            platformRole: PlatformRole.ORG_USER,
            emailVerified: true,
            isActive: true,
          },
        });

        await tx.orgMemeberShip.create({
          data: { userId: user.id, organisationId: caller.orgId!, orgRole },
        });

        isNewUser = true;
      } else {
        await tx.orgMemeberShip.upsert({
          where: {
            userId_organisationId: {
              userId: user.id,
              organisationId: caller.orgId!,
            },
          },
          create: { userId: user.id, organisationId: caller.orgId!, orgRole },
          update: { orgRole },
        });

        await tx.user.update({
          where: { id: user.id },
          data: { isActive: true },
        });
      }

      if (siteRole && dto.locationId) {
        await tx.siteAccess.upsert({
          where: { userId_siteId: { userId: user.id, siteId: dto.locationId } },
          create: {
            userId: user.id,
            siteId: dto.locationId,
            organisationId: caller.orgId!,
            siteRole,
            grantedBy: caller.sub,
            canClaimPickupsDirectly: dto.canClaimPickupsDirectly ?? false,
          },
          update: {
            siteRole,
            grantedBy: caller.sub,
            canClaimPickupsDirectly: dto.canClaimPickupsDirectly ?? false,
          },
        });
      }

      return { user, isNewUser };
    });

    if (result.isNewUser) {
      await this.emailService.sendStaffInvite({
        to: dto.email,
        name: dto.firstName,
        email: dto.email,
        password: dto.password,
        siteName: site?.organisationName ?? 'Head Office',
        role: this.getRoleDisplayName(dto.role),
      });
    }

    await this.cache.invalidateUsers(caller.orgId!);
    if (dto.locationId) await this.cache.invalidateLocation(dto.locationId);

    this.logger.log(
      `Charity member added: userId=${result.user.id} role=${dto.role} org=${caller.orgId} by=${caller.sub}`,
    );

    return {
      message: result.isNewUser
        ? 'Member added. Login credentials sent via email.'
        : 'Existing user added to charity.',
      user: {
        id: result.user.id,
        firstName: result.user.firstName,
        lastName: result.user.lastName,
        email: result.user.email,
        role: dto.role,
        locationId: dto.locationId ?? null,
      },
    };
  }

  async listUsers(caller: Jwtpayload) {
    this.assertCharityOrg(caller);

    const cached = await this.cache.getUsers<any>(caller.orgId!);
    if (cached) return cached;

    const [memberships, siteAccesses] = await Promise.all([
      this.prisma.orgMemeberShip.findMany({
        where: { organisationId: caller.orgId },
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
        orderBy: { joinedAt: 'asc' },
      }),
      this.prisma.siteAccess.findMany({
        where: { organisationId: caller.orgId },
        include: { site: { select: { id: true, organisationName: true } } },
      }),
    ]);

    const accessByUser = new Map<number, typeof siteAccesses>();
    for (const a of siteAccesses) {
      const list = accessByUser.get(a.userId) ?? [];
      list.push(a);
      accessByUser.set(a.userId, list);
    }

    const headOfficeAdmins: any[] = [];
    const headOfficeMembers: any[] = [];
    const locationAdmins: any[] = [];
    const teamMembers: any[] = [];
    const drivers: any[] = [];

    for (const m of memberships) {
      const accesses = accessByUser.get(m.userId) ?? [];
      const base = {
        id: m.user.id,
        firstName: m.user.firstName,
        lastName: m.user.lastName,
        email: m.user.email,
        mobile: m.user.phoneNumber,
        isActive: m.user.isActive,
        joinedAt: m.joinedAt,
        locations: accesses.map((a) => ({
          id: a.site.id,
          name: a.site.organisationName,
          siteRole: a.siteRole,
          canClaimPickupsDirectly: a.canClaimPickupsDirectly,
        })),
      };

      if (m.orgRole === OrgRole.SUPER_ADMIN) {
        headOfficeAdmins.push(base);
      } else if (accesses.some((a) => a.siteRole === SiteRole.SITE_ADMIN)) {
        locationAdmins.push(base);
      } else if (accesses.some((a) => a.siteRole === SiteRole.DRIVER)) {
        drivers.push(base);
      } else if (accesses.some((a) => a.siteRole === SiteRole.STAFF)) {
        teamMembers.push(base);
      } else {
        headOfficeMembers.push(base);
      }
    }

    const result = {
      headOfficeAdmins,
      headOfficeMembers,
      locationAdmins,
      teamMembers,
      drivers,
      totalCount: memberships.length,
    };

    await this.cache.setUsers(caller.orgId!, result);
    return result;
  }

  async getUser(caller: Jwtpayload, targetUserId: number) {
    this.assertCharityOrg(caller);

    const [membership, accesses] = await Promise.all([
      this.prisma.orgMemeberShip.findFirst({
        where: { userId: targetUserId, organisationId: caller.orgId },
        include: {
          user: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              email: true,
              phoneNumber: true,
              isActive: true,
              createdAt: true,
            },
          },
        },
      }),
      this.prisma.siteAccess.findMany({
        where: { userId: targetUserId, organisationId: caller.orgId },
        include: {
          site: {
            select: {
              id: true,
              organisationName: true,
              address: true,
              postcode: true,
            },
          },
        },
      }),
    ]);
    if (!membership)
      throw new NotFoundException('User not found in your organisation');

    return {
      id: membership.user.id,
      firstName: membership.user.firstName,
      lastName: membership.user.lastName,
      email: membership.user.email,
      mobile: membership.user.phoneNumber,
      isActive: membership.user.isActive,
      joinedAt: membership.joinedAt,
      orgRole: membership.orgRole,
      locations: accesses.map((a) => ({
        id: a.site.id,
        name: a.site.organisationName,
        address: a.site.address,
        postcode: a.site.postcode,
        siteRole: a.siteRole,
        canClaimPickupsDirectly: a.canClaimPickupsDirectly,
        grantedAt: a.grantedAt,
      })),
    };
  }

  async updateUser(
    caller: Jwtpayload,
    targetUserId: number,
    dto: UpdateCharityMemberDto,
  ) {
    this.assertCharityOrg(caller);

    const membership = await this.prisma.orgMemeberShip.findFirst({
      where: { userId: targetUserId, organisationId: caller.orgId },
    });
    if (!membership)
      throw new NotFoundException('User not found in your organisation');

    if (caller.orgRole !== OrgRole.SUPER_ADMIN) {
      const access = await this.prisma.siteAccess.findFirst({
        where: { userId: targetUserId, siteId: caller.siteId },
      });
      if (!access)
        throw new ForbiddenException(
          'You can only update members of your location',
        );
    }

    await this.prisma.user.update({
      where: { id: targetUserId },
      data: {
        ...(dto.firstName && { firstName: dto.firstName }),
        ...(dto.lastName && { lastName: dto.lastName }),
        ...(dto.mobile !== undefined && { phoneNumber: dto.mobile }),
      },
    });

    if (dto.canClaimPickupsDirectly !== undefined) {
      await this.prisma.siteAccess.updateMany({
        where: { userId: targetUserId, organisationId: caller.orgId },
        data: { canClaimPickupsDirectly: dto.canClaimPickupsDirectly },
      });
    }

    await this.cache.invalidateUsers(caller.orgId!);
    return { message: 'User updated successfully' };
  }

  async deactivateUser(caller: Jwtpayload, targetUserId: number) {
    this.assertSuperAdmin(caller);
    this.assertCharityOrg(caller);
    await this.assertUserInOrg(targetUserId, caller.orgId!);

    await this.prisma.user.update({
      where: { id: targetUserId },
      data: { isActive: false },
    });
    await this.cache.invalidateUsers(caller.orgId!);
    return { message: 'User deactivated successfully' };
  }

  async activateUser(caller: Jwtpayload, targetUserId: number) {
    this.assertSuperAdmin(caller);
    this.assertCharityOrg(caller);
    await this.assertUserInOrg(targetUserId, caller.orgId!);

    await this.prisma.user.update({
      where: { id: targetUserId },
      data: { isActive: true },
    });
    await this.cache.invalidateUsers(caller.orgId!);
    return { message: 'User activated successfully' };
  }

  async deleteUser(caller: Jwtpayload, targetUserId: number) {
    this.assertSuperAdmin(caller);
    this.assertCharityOrg(caller);
    await this.assertUserInOrg(targetUserId, caller.orgId!);

    await this.prisma.$transaction(async (tx) => {
      await tx.siteAccess.deleteMany({
        where: { userId: targetUserId, organisationId: caller.orgId },
      });
      await tx.orgMemeberShip.delete({
        where: {
          userId_organisationId: {
            userId: targetUserId,
            organisationId: caller.orgId!,
          },
        },
      });
      await tx.user.update({
        where: { id: targetUserId },
        data: { isActive: false },
      });
    });

    await this.cache.invalidateUsers(caller.orgId!);
    this.logger.log(
      `User removed from org: userId=${targetUserId} org=${caller.orgId}`,
    );
    return { message: 'User removed from organisation' };
  }

  /**
   * Remove a member from one location only.
   * If they still manage other sites in the org, keep their account.
   * If this was their last site, remove them from the organisation.
   */
  async removeUserFromLocation(
    caller: Jwtpayload,
    targetUserId: number,
    locationId: number,
  ) {
    this.assertSuperAdmin(caller);
    this.assertCharityOrg(caller);
    await this.assertUserInOrg(targetUserId, caller.orgId!);

    const site = await this.prisma.site.findFirst({
      where: { id: locationId, organisationId: caller.orgId },
    });
    if (!site) throw new NotFoundException('Location not found');

    const access = await this.prisma.siteAccess.findFirst({
      where: {
        userId: targetUserId,
        siteId: locationId,
        organisationId: caller.orgId,
      },
    });
    if (!access) {
      throw new NotFoundException('User is not assigned to this location');
    }

    await this.prisma.siteAccess.delete({
      where: { userId_siteId: { userId: targetUserId, siteId: locationId } },
    });

    const remainingAccess = await this.prisma.siteAccess.count({
      where: { userId: targetUserId, organisationId: caller.orgId },
    });

    if (remainingAccess === 0) {
      await this.prisma.$transaction(async (tx) => {
        await tx.orgMemeberShip.delete({
          where: {
            userId_organisationId: {
              userId: targetUserId,
              organisationId: caller.orgId!,
            },
          },
        });
        await tx.user.update({
          where: { id: targetUserId },
          data: { isActive: false },
        });
      });
      this.logger.log(
        `User removed from last location and org: userId=${targetUserId} location=${locationId} org=${caller.orgId}`,
      );
    } else {
      this.logger.log(
        `User removed from location only: userId=${targetUserId} location=${locationId} remaining=${remainingAccess} org=${caller.orgId}`,
      );
    }

    await this.cache.invalidateUsers(caller.orgId!);
    await this.cache.invalidateLocation(locationId);

    return {
      message:
        remainingAccess === 0
          ? 'User removed from location and organisation'
          : 'User removed from location',
      remainingLocations: remainingAccess,
    };
  }

  async resendInvite(
    caller: Jwtpayload,
    targetUserId: number,
    newPassword: string,
  ) {
    this.assertSuperAdmin(caller);
    this.assertCharityOrg(caller);

    const membership = await this.prisma.orgMemeberShip.findFirst({
      where: { userId: targetUserId, organisationId: caller.orgId },
      include: { user: true },
    });
    if (!membership)
      throw new NotFoundException('User not found in your organisation');

    const siteAccess = await this.prisma.siteAccess.findFirst({
      where: { userId: targetUserId, organisationId: caller.orgId },
      include: { site: { select: { organisationName: true } } },
    });

    const passwordHash = await bcrypt.hash(newPassword, 10);
    await this.prisma.user.update({
      where: { id: targetUserId },
      data: { passwordHash },
    });

    await this.emailService.sendStaffInvite({
      to: membership.user.email,
      name: membership.user.firstName,
      email: membership.user.email,
      password: newPassword,
      siteName: siteAccess?.site.organisationName ?? 'Head Office',
      role: this.getOrgRoleDisplayName(
        membership.orgRole,
        siteAccess?.siteRole,
      ),
    });

    return { message: 'Invite resent successfully' };
  }

  private mapCharityRole(role: CharityMemberRole): {
    orgRole: OrgRole;
    siteRole: SiteRole | null;
  } {
    switch (role) {
      case CharityMemberRole.HEAD_OFFICE_ADMIN:
        return { orgRole: OrgRole.SUPER_ADMIN, siteRole: null };
      case CharityMemberRole.HEAD_OFFICE:
        return { orgRole: OrgRole.ORG_MEMBER, siteRole: null };
      case CharityMemberRole.LOCATION_ADMIN:
        return { orgRole: OrgRole.ORG_MEMBER, siteRole: SiteRole.SITE_ADMIN };
      case CharityMemberRole.TEAM_MEMBER:
        return { orgRole: OrgRole.ORG_MEMBER, siteRole: SiteRole.STAFF };
      case CharityMemberRole.DRIVER:
        return { orgRole: OrgRole.ORG_MEMBER, siteRole: SiteRole.DRIVER };
    }
  }

  private getRoleDisplayName(role: CharityMemberRole): string {
    const map: Record<CharityMemberRole, string> = {
      [CharityMemberRole.HEAD_OFFICE_ADMIN]: 'Head Office Admin',
      [CharityMemberRole.HEAD_OFFICE]: 'Head Office Member',
      [CharityMemberRole.LOCATION_ADMIN]: 'Location Admin',
      [CharityMemberRole.TEAM_MEMBER]: 'Team Member',
      [CharityMemberRole.DRIVER]: 'Driver',
    };
    return map[role];
  }

  private getOrgRoleDisplayName(
    orgRole: OrgRole,
    siteRole?: SiteRole | null,
  ): string {
    if (orgRole === OrgRole.SUPER_ADMIN) return 'Head Office Admin';
    if (!siteRole) return 'Head Office Member';
    if (siteRole === SiteRole.SITE_ADMIN) return 'Location Admin';
    if (siteRole === SiteRole.DRIVER) return 'Driver';
    return 'Team Member';
  }

  private formatLocation(s: any) {
    return {
      id: s.id,
      locationName: s.organisationName,
      address: s.address,
      postcode: s.postcode,
      contactName: s.contactName,
      contactEmail: s.contactEmail,
      contactMobile: s.contactMobile,
      pickupRadiusKm: s.pickupRadiusKm,
      latitude: s.latitude,
      longitude: s.longitude,
      isActive: s.isActive,
      createdAt: s.createdAt,
    };
  }

  private assertSuperAdmin(caller: Jwtpayload) {
    if (caller.orgRole !== OrgRole.SUPER_ADMIN) {
      throw new ForbiddenException(
        'Only head office admins can perform this action',
      );
    }
  }

  private assertCharityOrg(caller: Jwtpayload) {
    if (!caller.orgType || !CHARITY_ORG_TYPES.includes(caller.orgType)) {
      throw new ForbiddenException(
        'This endpoint is only available for charity organisations',
      );
    }
  }

  private assertMultiCharity(caller: Jwtpayload) {
    if (caller.orgType !== OrgType.CHARITY_MULTI) {
      throw new ForbiddenException(
        'Location management is only available for multi-location charities',
      );
    }
  }

  private assertLocationAccess(caller: Jwtpayload, locationId: number) {
    if (caller.orgRole === OrgRole.SUPER_ADMIN) return;
    if (caller.siteId === locationId) return;
    throw new ForbiddenException('You do not have access to this location');
  }

  private async assertUserInOrg(userId: number, orgId: number) {
    const m = await this.prisma.orgMemeberShip.findFirst({
      where: { userId, organisationId: orgId },
    });
    if (!m) throw new NotFoundException('User not found in your organisation');
  }
}
