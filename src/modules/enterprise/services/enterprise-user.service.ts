import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  EnterpriseRole,
  InvitationStatus,
  OrgRole,
  ScopeType,
} from '@prisma/client';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { Jwtpayload } from '../../auth/interface/jwt.interface';
import { EmailQueueService } from '../../notifications/queues/email.queue.service';
import {
  InviteUserDto,
  ScopeGrantDto,
  SetUserScopesDto,
  UpdateEnterpriseUserDto,
} from '../dto/enterprise.dto';
import { ENTERPRISE_ERROR } from '../enterprise.constants';
import { EnterpriseAuditService } from './enterprise-audit.service';
import { EnterpriseInvitationService } from './enterprise-invitation.service';
import { EnterpriseScopeService } from './enterprise-scope.service';

/** Roles that may administer other users, and how far their reach extends. */
const ADMIN_ROLES: EnterpriseRole[] = [
  EnterpriseRole.SUPER_ADMIN,
  EnterpriseRole.ENTERPRISE_ADMIN,
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
    private readonly invitations: EnterpriseInvitationService,
    private readonly audit: EnterpriseAuditService,
  ) {}

  // ─── Invite ────────────────────────────────────────────────────────────────

  /**
   * Invites a user. No password is created on their behalf — they receive a
   * time-limited activation link and set their own, per the Enterprise Account
   * Activation rules.
   *
   * The role and scope are held on the invitation until it is accepted, so an
   * unopened invite never leaves a half-provisioned user behind.
   */
  async inviteUser(caller: Jwtpayload, dto: InviteUserDto) {
    const orgId = await this.assertUserAdmin(caller);
    await this.assertCanGrantRole(caller, dto.role);

    const scopes = this.normaliseScopes(dto.role, dto.scopes);
    await this.assertScopesWithinCallerReach(caller, orgId, scopes);
    await this.assertScopeTargetsExist(orgId, scopes);

    const actor = await this.audit.actorFrom(caller);
    const invitation = await this.invitations.issue(
      {
        organisationId: orgId,
        email: dto.email,
        firstName: dto.firstName,
        lastName: dto.lastName,
        mobile: dto.mobile ?? null,
        role: dto.role,
        scopes: scopes.map((sc) => ({
          scopeType: sc.scopeType,
          scopeId: sc.scopeId ?? null,
        })),
        siteAdminForSiteId: dto.siteAdminForSiteId ?? null,
        invitedBy: caller.sub,
      },
      actor,
    );

    this.logger.log(
      `Enterprise user invited: email=${invitation.email} role=${dto.role} ` +
        `scopes=${scopes.length} org=${orgId} by=${caller.sub}`,
    );

    return {
      message: 'Invitation sent. The user will set their own password.',
      invitation: {
        id: invitation.invitationId,
        email: invitation.email,
        role: this.roleLabel(dto.role),
        status: 'PENDING',
        sentAt: new Date(),
        expiresAt: invitation.expiresAt,
      },
    };
  }

  /** Pending invitations, shown alongside members in the Users listing. */
  async listInvitations(caller: Jwtpayload) {
    const orgId = await this.assertUserAdmin(caller);

    const rows = await this.prisma.enterpriseInvitation.findMany({
      where: { organisationId: orgId, status: InvitationStatus.PENDING },
      orderBy: { sentAt: 'desc' },
      include: { scopes: { select: { scopeType: true, scopeId: true } } },
    });
    const labels = await this.scopeLabels(orgId);

    return rows.map((r) => ({
      id: r.id,
      firstName: r.firstName,
      lastName: r.lastName,
      email: r.email,
      role: r.enterpriseRole,
      roleLabel: this.roleLabel(r.enterpriseRole),
      status: 'INVITED' as const,
      invitationSentAt: r.sentAt,
      expiresAt: r.expiresAt,
      scopes: r.scopes.map((sc) => ({
        scopeType: sc.scopeType,
        scopeId: sc.scopeId,
        name: labels.get(`${sc.scopeType}:${sc.scopeId ?? ''}`) ?? null,
      })),
    }));
  }

  /** Reissues the link, invalidating the previous one. */
  async resendInvitation(caller: Jwtpayload, invitationId: number) {
    const orgId = await this.assertUserAdmin(caller);
    const actor = await this.audit.actorFrom(caller);
    const result = await this.invitations.resend(orgId, invitationId, actor);
    return { message: 'Invitation resent. The previous link no longer works.', ...result };
  }

  async revokeInvitation(caller: Jwtpayload, invitationId: number) {
    const orgId = await this.assertUserAdmin(caller);
    const actor = await this.audit.actorFrom(caller);
    return this.invitations.revoke(orgId, invitationId, actor);
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
            termsAcceptedAt: true,
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
            termsAcceptedAt: true,
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

  /**
   * Resends to an existing member by re-inviting them. Administrators never
   * set another person's password, so there is no password path here.
   */
  async resendInviteForUser(caller: Jwtpayload, userId: number) {
    const orgId = await this.assertUserAdmin(caller);
    const membership = await this.requireMembership(userId, orgId);
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });

    const pending = await this.prisma.enterpriseInvitation.findFirst({
      where: { organisationId: orgId, email: user.email, status: InvitationStatus.PENDING },
      orderBy: { sentAt: 'desc' },
      select: { id: true },
    });

    const actor = await this.audit.actorFrom(caller);
    if (pending) {
      const result = await this.invitations.resend(orgId, pending.id, actor);
      return { message: 'Invitation resent. The previous link no longer works.', ...result };
    }

    const scopes = await this.prisma.userScope.findMany({
      where: { userId, organisationId: orgId },
      select: { scopeType: true, scopeId: true },
    });

    const result = await this.invitations.issue(
      {
        organisationId: orgId,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        mobile: user.phoneNumber,
        role: membership.enterpriseRole ?? this.legacyRole(membership.orgRole),
        scopes,
        invitedBy: caller.sub,
      },
      actor,
    );
    return { message: 'Invitation sent.', ...result };
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

    // Only a Super Admin may mint another Super Admin.
    if (
      callerRole === EnterpriseRole.ENTERPRISE_ADMIN &&
      role !== EnterpriseRole.SUPER_ADMIN
    ) {
      return;
    }

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

  /**
   * Activation is what makes a user Active, not their first sign-in — a person
   * who has set their password and accepted the terms is Active even before
   * they log in again. `lastLoginAt` remains the fallback for accounts created
   * before the invitation flow existed.
   */
  private statusOf(user: {
    isActive: boolean;
    lastLoginAt: Date | null;
    termsAcceptedAt?: Date | null;
  }): UserStatus {
    if (!user.isActive) return 'DEACTIVATED';
    if (user.termsAcceptedAt) return 'ACTIVE';
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
      ENTERPRISE_ADMIN: 'Enterprise Admin',
      REPORTING_USER: 'Reporting User',
      GROUP_ADMIN: 'Group Admin',
      SITE_ADMIN: 'Site Admin',
      // Retained for existing rows only — not offered in the Enterprise Portal,
      // which defines five roles (Roles & Permissions, page 17).
      CLUSTER_ADMIN: 'Cluster Admin',
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
