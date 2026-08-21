import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { EnterpriseRole, OrgRole, PlatformRole, ScopeType } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { Jwtpayload } from '../../auth/interface/jwt.interface';
import { EmailQueueService } from '../../notifications/queues/email.queue.service';
import {
  InviteEnterpriseUserDto,
  ResendInviteDto,
  ScopeGrantDto,
  SetUserScopesDto,
  UpdateEnterpriseUserDto,
} from '../dto/enterprise.dto';
import { ENTERPRISE_ERROR } from '../enterprise.constants';
import { EnterpriseScopeService } from './enterprise-scope.service';

/** Roles that may administer other users, and how far their reach extends. */
const ADMIN_ROLES: EnterpriseRole[] = [
  EnterpriseRole.SUPER_ADMIN,
  EnterpriseRole.GROUP_ADMIN,
];

type UserStatus = 'INVITED' | 'ACTIVE' | 'DEACTIVATED';

@Injectable()
export class EnterpriseUserService {
  private readonly logger = new Logger(EnterpriseUserService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: EnterpriseScopeService,
    private readonly emailService: EmailQueueService,
  ) {}

  // ─── Invite ────────────────────────────────────────────────────────────────

  async inviteUser(caller: Jwtpayload, dto: InviteEnterpriseUserDto) {
    const orgId = await this.assertUserAdmin(caller);
    await this.assertCanGrantRole(caller, dto.role);

    const scopes = this.normaliseScopes(dto.role, dto.scopes);
    await this.assertScopesWithinCallerReach(caller, orgId, scopes);
    await this.assertScopeTargetsExist(orgId, scopes);

    const email = dto.email.trim().toLowerCase();
    const existing = await this.prisma.user.findUnique({ where: { email } });

    if (existing) {
      const otherOrg = await this.prisma.orgMemeberShip.findFirst({
        where: { userId: existing.id, organisationId: { not: orgId } },
      });
      if (otherOrg) {
        throw new ConflictException(
          'That email already belongs to a different organisation',
        );
      }
    }

    const passwordHash = await bcrypt.hash(dto.password, 10);

    const result = await this.prisma.$transaction(async (tx) => {
      const user = existing
        ? await tx.user.update({
            where: { id: existing.id },
            data: { passwordHash, isActive: true },
          })
        : await tx.user.create({
            data: {
              firstName: dto.firstName,
              lastName: dto.lastName,
              email,
              passwordHash,
              phoneNumber: dto.mobile ?? '',
              platformRole: PlatformRole.ORG_USER,
              emailVerified: true,
              isActive: true,
            },
          });

      await tx.orgMemeberShip.upsert({
        where: { userId_organisationId: { userId: user.id, organisationId: orgId } },
        create: {
          userId: user.id,
          organisationId: orgId,
          orgRole:
            dto.role === EnterpriseRole.SUPER_ADMIN
              ? OrgRole.SUPER_ADMIN
              : OrgRole.ORG_MEMBER,
          enterpriseRole: dto.role,
        },
        update: { enterpriseRole: dto.role },
      });

      await tx.userScope.deleteMany({ where: { userId: user.id, organisationId: orgId } });
      if (scopes.length) {
        await tx.userScope.createMany({
          data: scopes.map((s) => ({
            userId: user.id,
            organisationId: orgId,
            scopeType: s.scopeType,
            scopeId: s.scopeId ?? null,
            grantedBy: caller.sub,
          })),
        });
      }

      return user;
    });

    const org = await this.prisma.organisation.findUnique({
      where: { id: orgId },
      select: { name: true },
    });

    await this.emailService
      .sendStaffInvite({
        to: email,
        name: dto.firstName,
        email,
        password: dto.password,
        siteName: org?.name ?? 'your organisation',
        role: this.roleLabel(dto.role),
      })
      .catch((err) => this.logger.warn(`invite email failed: ${err.message}`));

    this.logger.log(
      `Enterprise user invited: id=${result.id} role=${dto.role} ` +
        `scopes=${scopes.length} org=${orgId} by=${caller.sub}`,
    );

    return {
      message: 'User invited. Login credentials sent by email.',
      user: await this.getUser(caller, result.id),
    };
  }

  // ─── Read ──────────────────────────────────────────────────────────────────

  async listUsers(caller: Jwtpayload) {
    const orgId = await this.scope.assertEnterprise(caller);

    const memberships = await this.prisma.orgMemeberShip.findMany({
      where: { organisationId: orgId },
      orderBy: { joinedAt: 'asc' },
      include: {
        user: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
            phoneNumber: true,
            isActive: true,
            lastLoginAt: true,
          },
        },
      },
    });

    const scopes = await this.prisma.userScope.findMany({
      where: { organisationId: orgId },
    });
    const labels = await this.scopeLabels(orgId);

    const byUser = new Map<number, typeof scopes>();
    for (const s of scopes) {
      const list = byUser.get(s.userId) ?? [];
      list.push(s);
      byUser.set(s.userId, list);
    }

    return memberships.map((m) => ({
      id: m.user.id,
      firstName: m.user.firstName,
      lastName: m.user.lastName,
      email: m.user.email,
      mobile: m.user.phoneNumber,
      role: m.enterpriseRole ?? this.legacyRole(m.orgRole),
      status: this.statusOf(m.user),
      lastLoginAt: m.user.lastLoginAt,
      joinedAt: m.joinedAt,
      scopes: (byUser.get(m.user.id) ?? []).map((s) => ({
        scopeType: s.scopeType,
        scopeId: s.scopeId,
        name: labels.get(`${s.scopeType}:${s.scopeId ?? ''}`) ?? null,
      })),
    }));
  }

  async getUser(caller: Jwtpayload, userId: number) {
    const orgId = await this.scope.assertEnterprise(caller);

    const membership = await this.prisma.orgMemeberShip.findFirst({
      where: { userId, organisationId: orgId },
      include: {
        user: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
            phoneNumber: true,
            isActive: true,
            lastLoginAt: true,
            createdAt: true,
          },
        },
      },
    });
    if (!membership) throw new NotFoundException('User not found in your organisation');

    const scopes = await this.prisma.userScope.findMany({
      where: { userId, organisationId: orgId },
    });
    const labels = await this.scopeLabels(orgId);

    const reach = await this.scope.getAllowedSiteIds({
      ...caller,
      sub: userId,
    } as Jwtpayload);

    return {
      id: membership.user.id,
      firstName: membership.user.firstName,
      lastName: membership.user.lastName,
      email: membership.user.email,
      mobile: membership.user.phoneNumber,
      role: membership.enterpriseRole ?? this.legacyRole(membership.orgRole),
      status: this.statusOf(membership.user),
      lastLoginAt: membership.user.lastLoginAt,
      joinedAt: membership.joinedAt,
      scopes: scopes.map((s) => ({
        scopeType: s.scopeType,
        scopeId: s.scopeId,
        name: labels.get(`${s.scopeType}:${s.scopeId ?? ''}`) ?? null,
        grantedAt: s.grantedAt,
      })),
      reach: reach === null ? 'ENTIRE_ENTERPRISE' : { siteCount: reach.length },
    };
  }

  // ─── Update ────────────────────────────────────────────────────────────────

  async updateUser(caller: Jwtpayload, userId: number, dto: UpdateEnterpriseUserDto) {
    const orgId = await this.assertUserAdmin(caller);
    const membership = await this.requireMembership(userId, orgId);

    if (dto.role) {
      await this.assertCanGrantRole(caller, dto.role);
      await this.assertNotLastSuperAdmin(orgId, userId, dto.role);
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: {
          ...(dto.firstName && { firstName: dto.firstName }),
          ...(dto.lastName && { lastName: dto.lastName }),
          ...(dto.mobile !== undefined && { phoneNumber: dto.mobile }),
        },
      });

      if (dto.role) {
        await tx.orgMemeberShip.update({
          where: { id: membership.id },
          data: {
            enterpriseRole: dto.role,
            orgRole:
              dto.role === EnterpriseRole.SUPER_ADMIN
                ? OrgRole.SUPER_ADMIN
                : OrgRole.ORG_MEMBER,
          },
        });

        // A Super Admin covers everything, so explicit grants become noise.
        if (dto.role === EnterpriseRole.SUPER_ADMIN) {
          await tx.userScope.deleteMany({ where: { userId, organisationId: orgId } });
        }
      }
    });

    return this.getUser(caller, userId);
  }

  /** Replaces a user's scope grants wholesale. */
  async setScopes(caller: Jwtpayload, userId: number, dto: SetUserScopesDto) {
    const orgId = await this.assertUserAdmin(caller);
    const membership = await this.requireMembership(userId, orgId);

    const role = membership.enterpriseRole ?? this.legacyRole(membership.orgRole);
    if (role === EnterpriseRole.SUPER_ADMIN) {
      throw new BadRequestException(
        'A Super Admin already covers the entire Enterprise and cannot be scoped.',
      );
    }

    const scopes = this.normaliseScopes(role, dto.scopes);
    await this.assertScopesWithinCallerReach(caller, orgId, scopes);
    await this.assertScopeTargetsExist(orgId, scopes);

    await this.prisma.$transaction(async (tx) => {
      await tx.userScope.deleteMany({ where: { userId, organisationId: orgId } });
      if (scopes.length) {
        await tx.userScope.createMany({
          data: scopes.map((s) => ({
            userId,
            organisationId: orgId,
            scopeType: s.scopeType,
            scopeId: s.scopeId ?? null,
            grantedBy: caller.sub,
          })),
        });
      }
    });

    this.logger.log(`Scopes set for user=${userId}: ${scopes.length} grant(s) by=${caller.sub}`);
    return this.getUser(caller, userId);
  }

  async setActive(caller: Jwtpayload, userId: number, isActive: boolean) {
    const orgId = await this.assertUserAdmin(caller);
    const membership = await this.requireMembership(userId, orgId);

    if (!isActive) {
      const role = membership.enterpriseRole ?? this.legacyRole(membership.orgRole);
      await this.assertNotLastSuperAdmin(orgId, userId, null, role);
    }

    await this.prisma.user.update({ where: { id: userId }, data: { isActive } });

    this.logger.log(
      `User ${userId} ${isActive ? 'activated' : 'deactivated'} in org=${orgId} by=${caller.sub}`,
    );
    return { message: isActive ? 'User activated' : 'User deactivated' };
  }

  async resendInvite(caller: Jwtpayload, userId: number, dto: ResendInviteDto) {
    const orgId = await this.assertUserAdmin(caller);
    const membership = await this.requireMembership(userId, orgId);

    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const org = await this.prisma.organisation.findUnique({
      where: { id: orgId },
      select: { name: true },
    });

    await this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash: await bcrypt.hash(dto.newPassword, 10) },
    });

    await this.emailService.sendStaffInvite({
      to: user.email,
      name: user.firstName,
      email: user.email,
      password: dto.newPassword,
      siteName: org?.name ?? 'your organisation',
      role: this.roleLabel(membership.enterpriseRole ?? this.legacyRole(membership.orgRole)),
    });

    return { message: 'Invite resent' };
  }

  // ─── Guards ────────────────────────────────────────────────────────────────

  private async assertUserAdmin(caller: Jwtpayload): Promise<number> {
    const orgId = await this.scope.assertEnterprise(caller);
    const role = await this.scope.getEnterpriseRole(caller);

    if (!role || !ADMIN_ROLES.includes(role)) {
      throw new ForbiddenException('You do not have permission to manage users');
    }
    return orgId;
  }

  /** A Group Admin may not mint Super Admins or other Group Admins. */
  private async assertCanGrantRole(caller: Jwtpayload, role: EnterpriseRole) {
    const callerRole = await this.scope.getEnterpriseRole(caller);
    if (callerRole === EnterpriseRole.SUPER_ADMIN) return;

    if (role === EnterpriseRole.SUPER_ADMIN || role === EnterpriseRole.GROUP_ADMIN) {
      throw new ForbiddenException(`Only a Super Admin can assign the ${role} role`);
    }
  }

  /** Nobody may hand out access they do not themselves hold. */
  private async assertScopesWithinCallerReach(
    caller: Jwtpayload,
    orgId: number,
    scopes: ScopeGrantDto[],
  ) {
    const callerReach = await this.scope.getAllowedSiteIds(caller);
    if (callerReach === null) return; // Super Admin

    const allowed = new Set(callerReach);
    for (const s of scopes) {
      const resolved = await this.scope
        .resolve(orgId, s.scopeType as never, s.scopeId ?? null)
        .catch(() => null);
      if (!resolved) continue;

      const outside = resolved.siteIds.filter((id) => !allowed.has(id));
      if (outside.length) {
        throw new ForbiddenException({
          error: ENTERPRISE_ERROR.OUTSIDE_SCOPE,
          message: `You cannot grant access to "${resolved.label}" — it is outside your own scope.`,
        });
      }
    }
  }

  private async assertScopeTargetsExist(orgId: number, scopes: ScopeGrantDto[]) {
    for (const s of scopes) {
      if (s.scopeType === ScopeType.ENTERPRISE) continue;
      // resolve() throws NotFound when the target is missing or foreign
      await this.scope.resolve(orgId, s.scopeType as never, s.scopeId ?? null);
    }
  }

  /** Refuses to remove or demote the final active Super Admin. */
  private async assertNotLastSuperAdmin(
    orgId: number,
    userId: number,
    newRole: EnterpriseRole | null,
    currentRole?: EnterpriseRole,
  ) {
    const membership = await this.prisma.orgMemeberShip.findFirst({
      where: { userId, organisationId: orgId },
      select: { enterpriseRole: true, orgRole: true },
    });
    const role =
      currentRole ?? membership?.enterpriseRole ?? this.legacyRole(membership?.orgRole);

    if (role !== EnterpriseRole.SUPER_ADMIN) return;
    if (newRole === EnterpriseRole.SUPER_ADMIN) return;

    const others = await this.prisma.orgMemeberShip.count({
      where: {
        organisationId: orgId,
        userId: { not: userId },
        enterpriseRole: EnterpriseRole.SUPER_ADMIN,
        user: { isActive: true },
      },
    });

    if (others === 0) {
      throw new ConflictException({
        error: ENTERPRISE_ERROR.LAST_SUPER_ADMIN,
        message:
          'This is the only active Super Admin. Promote another user before changing this one.',
      });
    }
  }

  private async requireMembership(userId: number, orgId: number) {
    const membership = await this.prisma.orgMemeberShip.findFirst({
      where: { userId, organisationId: orgId },
    });
    if (!membership) throw new NotFoundException('User not found in your organisation');
    return membership;
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  /** A Super Admin is implicitly enterprise-wide, so explicit grants are dropped. */
  private normaliseScopes(
    role: EnterpriseRole,
    scopes?: ScopeGrantDto[],
  ): ScopeGrantDto[] {
    if (role === EnterpriseRole.SUPER_ADMIN) return [];
    return scopes ?? [];
  }

  private statusOf(user: { isActive: boolean; lastLoginAt: Date | null }): UserStatus {
    if (!user.isActive) return 'DEACTIVATED';
    return user.lastLoginAt ? 'ACTIVE' : 'INVITED';
  }

  private legacyRole(orgRole?: OrgRole | null): EnterpriseRole {
    return orgRole === OrgRole.SUPER_ADMIN
      ? EnterpriseRole.SUPER_ADMIN
      : EnterpriseRole.SITE_USER;
  }

  private roleLabel(role: EnterpriseRole): string {
    const map: Record<EnterpriseRole, string> = {
      SUPER_ADMIN: 'Enterprise Super Admin',
      REPORTING_USER: 'Reporting User',
      GROUP_ADMIN: 'Group Admin',
      CLUSTER_ADMIN: 'Cluster Admin',
      SITE_ADMIN: 'Site Admin',
      SITE_USER: 'Site User',
    };
    return map[role];
  }

  /** Friendly names for every scope target, for display alongside grants. */
  private async scopeLabels(orgId: number): Promise<Map<string, string>> {
    const [groups, clusters, territories, sites] = await Promise.all([
      this.prisma.enterpriseGroup.findMany({
        where: { organisationId: orgId },
        select: { id: true, name: true },
      }),
      this.prisma.cluster.findMany({
        where: { organisationId: orgId },
        select: { id: true, name: true },
      }),
      this.prisma.territory.findMany({
        where: { organisationId: orgId },
        select: { id: true, name: true },
      }),
      this.prisma.site.findMany({
        where: { organisationId: orgId },
        select: { id: true, organisationName: true },
      }),
    ]);

    const map = new Map<string, string>();
    map.set('ENTERPRISE:', 'Entire Enterprise');
    groups.forEach((g) => map.set(`GROUP:${g.id}`, g.name));
    clusters.forEach((c) => map.set(`CLUSTER:${c.id}`, c.name));
    territories.forEach((t) => map.set(`TERRITORY:${t.id}`, t.name));
    sites.forEach((s) => map.set(`SITE:${s.id}`, s.organisationName));
    return map;
  }
}
