import {
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
  AddFarmerConsumerMemberDto,
  FarmerConsumerMemberRole,
  UpdateFarmerConsumerMemberDto,
} from '../dto/farmer-consumer.dto';
import { FarmerConsumerCacheManager } from '../cache/farmer-consumer.cache.manager';

@Injectable()
export class FarmerConsumerService {
  private readonly logger = new Logger(FarmerConsumerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly emailService: EmailQueueService,
    private readonly cache: FarmerConsumerCacheManager,
  ) {}

  async addMember(caller: Jwtpayload, dto: AddFarmerConsumerMemberDto) {
    this.assertFarmerConsumerOrg(caller);
    this.assertSuperAdmin(caller);

    if (!caller.siteId) {
      throw new ForbiddenException('No site associated with your account');
    }

    const site = await this.prisma.site.findFirst({
      where: { id: caller.siteId, organisationId: caller.orgId },
    });
    if (!site) throw new NotFoundException('Site not found');

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

    const { orgRole, siteRole } = this.mapRole(dto.role);

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

      await tx.siteAccess.upsert({
        where: {
          userId_siteId: { userId: user.id, siteId: caller.siteId! },
        },
        create: {
          userId: user.id,
          siteId: caller.siteId!,
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

      return { user, isNewUser };
    });

    if (result.isNewUser) {
      await this.emailService.sendStaffInvite({
        to: dto.email,
        name: dto.firstName,
        email: dto.email,
        password: dto.password,
        siteName: site.organisationName,
        role: this.getRoleDisplayName(dto.role),
      });
    }

    await this.cache.invalidateUsers(caller.orgId!);

    this.logger.log(
      `FarmerConsumer member added: userId=${result.user.id} role=${dto.role} org=${caller.orgId} by=${caller.sub}`,
    );

    return {
      message: result.isNewUser
        ? 'Member added. Login credentials sent via email.'
        : 'Existing user added to farm.',
      user: {
        id: result.user.id,
        firstName: result.user.firstName,
        lastName: result.user.lastName,
        email: result.user.email,
        role: dto.role,
        siteId: caller.siteId,
      },
    };
  }

  async listUsers(caller: Jwtpayload) {
    this.assertFarmerConsumerOrg(caller);

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

    const admins: any[] = [];
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
        siteRole: accesses[0]?.siteRole ?? null,
        canClaimPickupsDirectly: accesses[0]?.canClaimPickupsDirectly ?? false,
      };

      if (m.orgRole === OrgRole.SUPER_ADMIN) {
        admins.push(base);
      } else if (accesses.some((a) => a.siteRole === SiteRole.DRIVER)) {
        drivers.push(base);
      } else {
        teamMembers.push(base);
      }
    }

    const result = { admins, teamMembers, drivers, totalCount: memberships.length };
    await this.cache.setUsers(caller.orgId!, result);
    return result;
  }

  async getUser(caller: Jwtpayload, targetUserId: number) {
    this.assertFarmerConsumerOrg(caller);

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
            select: { id: true, organisationName: true, address: true },
          },
        },
      }),
    ]);

    if (!membership) throw new NotFoundException('User not found in your organisation');

    return {
      id: membership.user.id,
      firstName: membership.user.firstName,
      lastName: membership.user.lastName,
      email: membership.user.email,
      mobile: membership.user.phoneNumber,
      isActive: membership.user.isActive,
      joinedAt: membership.joinedAt,
      orgRole: membership.orgRole,
      site: accesses[0]
        ? {
            id: accesses[0].site.id,
            name: accesses[0].site.organisationName,
            address: accesses[0].site.address,
            siteRole: accesses[0].siteRole,
            canClaimPickupsDirectly: accesses[0].canClaimPickupsDirectly,
            grantedAt: accesses[0].grantedAt,
          }
        : null,
    };
  }

  async updateUser(
    caller: Jwtpayload,
    targetUserId: number,
    dto: UpdateFarmerConsumerMemberDto,
  ) {
    this.assertFarmerConsumerOrg(caller);

    const membership = await this.prisma.orgMemeberShip.findFirst({
      where: { userId: targetUserId, organisationId: caller.orgId },
    });
    if (!membership) throw new NotFoundException('User not found in your organisation');

    if (caller.orgRole !== OrgRole.SUPER_ADMIN) {
      const access = await this.prisma.siteAccess.findFirst({
        where: { userId: targetUserId, siteId: caller.siteId },
      });
      if (!access) {
        throw new ForbiddenException('You can only update members of your site');
      }
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
    this.assertFarmerConsumerOrg(caller);
    this.assertSuperAdmin(caller);
    await this.assertUserInOrg(targetUserId, caller.orgId!);

    await this.prisma.user.update({
      where: { id: targetUserId },
      data: { isActive: false },
    });
    await this.cache.invalidateUsers(caller.orgId!);
    return { message: 'User deactivated successfully' };
  }

  async activateUser(caller: Jwtpayload, targetUserId: number) {
    this.assertFarmerConsumerOrg(caller);
    this.assertSuperAdmin(caller);
    await this.assertUserInOrg(targetUserId, caller.orgId!);

    await this.prisma.user.update({
      where: { id: targetUserId },
      data: { isActive: true },
    });
    await this.cache.invalidateUsers(caller.orgId!);
    return { message: 'User activated successfully' };
  }

  async deleteUser(caller: Jwtpayload, targetUserId: number) {
    this.assertFarmerConsumerOrg(caller);
    this.assertSuperAdmin(caller);
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
    this.logger.log(`User removed from farm org: userId=${targetUserId} org=${caller.orgId}`);
    return { message: 'User removed from organisation' };
  }

  async resendInvite(caller: Jwtpayload, targetUserId: number, newPassword: string) {
    this.assertFarmerConsumerOrg(caller);
    this.assertSuperAdmin(caller);

    const membership = await this.prisma.orgMemeberShip.findFirst({
      where: { userId: targetUserId, organisationId: caller.orgId },
      include: { user: true },
    });
    if (!membership) throw new NotFoundException('User not found in your organisation');

    const siteAccess = await this.prisma.siteAccess.findFirst({
      where: { userId: targetUserId, organisationId: caller.orgId },
      include: { site: { select: { organisationName: true } } },
    });

    const passwordHash = await bcrypt.hash(newPassword, 10);
    await this.prisma.user.update({
      where: { id: targetUserId },
      data: { passwordHash },
    });

    const roleDisplay = siteAccess?.siteRole === SiteRole.DRIVER
      ? 'Driver'
      : siteAccess?.siteRole === SiteRole.SITE_ADMIN
        ? 'Admin'
        : 'Team Member';

    await this.emailService.sendStaffInvite({
      to: membership.user.email,
      name: membership.user.firstName,
      email: membership.user.email,
      password: newPassword,
      siteName: siteAccess?.site.organisationName ?? 'Farm',
      role: roleDisplay,
    });

    return { message: 'Invite resent successfully' };
  }

  private mapRole(role: FarmerConsumerMemberRole): {
    orgRole: OrgRole;
    siteRole: SiteRole;
  } {
    switch (role) {
      case FarmerConsumerMemberRole.ADMIN:
        return { orgRole: OrgRole.ORG_MEMBER, siteRole: SiteRole.SITE_ADMIN };
      case FarmerConsumerMemberRole.TEAM_MEMBER:
        return { orgRole: OrgRole.ORG_MEMBER, siteRole: SiteRole.STAFF };
      case FarmerConsumerMemberRole.DRIVER:
        return { orgRole: OrgRole.ORG_MEMBER, siteRole: SiteRole.DRIVER };
    }
  }

  private getRoleDisplayName(role: FarmerConsumerMemberRole): string {
    const map: Record<FarmerConsumerMemberRole, string> = {
      [FarmerConsumerMemberRole.ADMIN]: 'Admin',
      [FarmerConsumerMemberRole.TEAM_MEMBER]: 'Team Member',
      [FarmerConsumerMemberRole.DRIVER]: 'Driver',
    };
    return map[role];
  }

  private assertFarmerConsumerOrg(caller: Jwtpayload) {
    if (caller.orgType !== OrgType.FARMER_CONSUMER) {
      throw new ForbiddenException(
        'This endpoint is only available for farmer consumer organisations',
      );
    }
  }

  private assertSuperAdmin(caller: Jwtpayload) {
    if (caller.orgRole !== OrgRole.SUPER_ADMIN) {
      throw new ForbiddenException('Only org admins can perform this action');
    }
  }

  private async assertUserInOrg(userId: number, orgId: number) {
    const m = await this.prisma.orgMemeberShip.findFirst({
      where: { userId, organisationId: orgId },
    });
    if (!m) throw new NotFoundException('User not found in your organisation');
  }
}
