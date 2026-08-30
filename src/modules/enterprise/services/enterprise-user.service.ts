import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditArea,
  EnterpriseRole,
  InvitationStatus,
  OrgRole,
  PlatformRole,
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
  UserListQueryDto,
  UserStatusFilter,
} from '../dto/enterprise.dto';
import { ENTERPRISE_ERROR } from '../enterprise.constants';
import { pageRequest, paginate } from '../enterprise.pagination';
import {
  assignableRolesFor,
  isPortalRole,
  isUnrestricted,
  PERMISSION,
  roleLabel,
  rolesMatrix,
} from '../enterprise.permissions';
import { EnterpriseAuditService } from './enterprise-audit.service';
import { EnterpriseInvitationService } from './enterprise-invitation.service';
import { EnterpriseScopeService } from './enterprise-scope.service';

type UserStatus = UserStatusFilter;

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
  async inviteUserForOrganisation(
    caller: Jwtpayload,
    organisationId: number,
    dto: InviteUserDto,
  ) {
    if (caller.platformRole !== PlatformRole.PLATFORM_ADMIN) {
      throw new ForbiddenException('Platform admin access required');
    }
    const org = await this.prisma.organisation.findUnique({
      where: { id: organisationId },
      select: { id: true },
    });
    if (!org) throw new NotFoundException('Enterprise not found');
    return this.issueInvite(caller, organisationId, dto);
  }

  async inviteUser(caller: Jwtpayload, dto: InviteUserDto) {
    const orgId = await this.assertUserAdmin(caller);
    await this.assertCanGrantRole(caller, dto.role);

    const scopes = this.normaliseScopes(dto.role, dto.scopes);
    this.assertScopeSatisfiesRole(dto.role, scopes);
    await this.assertScopesWithinCallerReach(caller, orgId, scopes);
    await this.assertScopeTargetsExist(orgId, scopes);
    return this.issueInvite(caller, orgId, dto);
  }

  private async issueInvite(
    caller: Jwtpayload,
    orgId: number,
    dto: InviteUserDto,
  ) {
    const scopes = this.normaliseScopes(dto.role, dto.scopes);
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

  /**
   * Users & Access: members and pending invitations in one list.
   *
   * Someone invited but not yet activated is a row on this screen, so the two
   * sources are merged before anything is filtered — which is also why paging
   * happens after the merge rather than in SQL. An Enterprise has tens of
   * administrators, not thousands, and the alternative is two pagers that
   * disagree about what page 2 contains.
   */
  async listUsers(caller: Jwtpayload, query: UserListQueryDto = {}) {
    const orgId = await this.scope.assertPermission(caller, PERMISSION.USERS_VIEW);
    const page = pageRequest(query.page, query.pageSize);

    const [memberships, invitations, scopeRows, siteAccess, labels, index, callerReach] =
      await Promise.all([
        this.prisma.orgMemeberShip.findMany({
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
        }),
        this.prisma.enterpriseInvitation.findMany({
          where: { organisationId: orgId, status: InvitationStatus.PENDING },
          orderBy: { sentAt: 'desc' },
          include: { scopes: { select: { scopeType: true, scopeId: true } } },
        }),
        this.prisma.userScope.findMany({ where: { organisationId: orgId } }),
        this.prisma.siteAccess.findMany({
          where: { organisationId: orgId },
          select: { userId: true, siteId: true },
        }),
        this.scopeLabels(orgId),
        this.scopeSiteIndex(orgId),
        this.scope.getAllowedSiteIds(caller),
      ]);

    const grantsByUser = new Map<number, Array<{ scopeType: ScopeType; scopeId: number | null }>>();
    for (const row of scopeRows) {
      const list = grantsByUser.get(row.userId) ?? [];
      list.push({ scopeType: row.scopeType, scopeId: row.scopeId });
      grantsByUser.set(row.userId, list);
    }

    const accessByUser = new Map<number, number[]>();
    for (const row of siteAccess) {
      const list = accessByUser.get(row.userId) ?? [];
      list.push(row.siteId);
      accessByUser.set(row.userId, list);
    }

    const describe = (list: Array<{ scopeType: ScopeType; scopeId: number | null }>) =>
      list.map((sc) => ({
        scopeType: sc.scopeType,
        scopeId: sc.scopeId,
        name: labels.get(`${sc.scopeType}:${sc.scopeId ?? ''}`) ?? null,
      }));

    const members = memberships.map((m) => {
      const role = m.enterpriseRole ?? this.legacyRole(m.orgRole);
      const grants = grantsByUser.get(m.user.id) ?? [];
      const reach = this.reachFrom(role, grants, accessByUser.get(m.user.id) ?? [], index);

      return {
        id: m.user.id,
        invitationId: null as number | null,
        firstName: m.user.firstName,
        lastName: m.user.lastName,
        email: m.user.email,
        mobile: m.user.phoneNumber,
        role,
        roleLabel: this.roleLabel(role),
        status: this.statusOf(m.user),
        lastLoginAt: m.user.lastLoginAt,
        joinedAt: m.joinedAt as Date | null,
        invitationSentAt: null as Date | null,
        invitationExpiresAt: null as Date | null,
        scopes: describe(grants),
        reach,
      };
    });

    // Invited people have no user row yet, so their role and scope still live
    // on the invitation. They read identically on the screen.
    const invited = invitations.map((inv) => {
      const grants = inv.scopes.map((sc) => ({
        scopeType: sc.scopeType,
        scopeId: sc.scopeId,
      }));
      return {
        id: null as number | null,
        invitationId: inv.id,
        firstName: inv.firstName,
        lastName: inv.lastName,
        email: inv.email,
        mobile: inv.mobile,
        role: inv.enterpriseRole,
        roleLabel: this.roleLabel(inv.enterpriseRole),
        status: 'INVITED' as UserStatus,
        lastLoginAt: null as Date | null,
        joinedAt: null as Date | null,
        invitationSentAt: inv.sentAt,
        invitationExpiresAt: inv.expiresAt,
        scopes: describe(grants),
        reach: this.reachFrom(inv.enterpriseRole, grants, [], index),
      };
    });

    const everyone = [...members, ...invited];

    // A scoped administrator sees the people they overlap with, plus anyone
    // whose reach is the whole Enterprise — hiding the admins from a Group
    // Admin would leave them with nobody to escalate to.
    const callerSites = callerReach === null ? null : new Set(callerReach);
    const withinReach = everyone.filter((row) => {
      if (callerSites === null) return true;
      if (row.reach === null) return true;
      return row.reach.some((siteId) => callerSites.has(siteId));
    });

    const search = query.search?.trim().toLowerCase();
    const scopeSites =
      query.scopeType !== undefined
        ? new Set(index.get(`${query.scopeType}:${query.scopeId ?? ''}`) ?? [])
        : null;

    const filtered = withinReach.filter((row) => {
      if (query.role && row.role !== query.role) return false;
      if (query.status && row.status !== query.status) return false;

      if (search) {
        const haystack = `${row.firstName} ${row.lastName} ${row.email}`.toLowerCase();
        if (!haystack.includes(search)) return false;
      }

      // "Who can see this structure": any overlap counts, so a Group Admin
      // covering half of it still appears.
      if (scopeSites) {
        if (row.reach === null) return true;
        if (!row.reach.some((siteId) => scopeSites.has(siteId))) return false;
      }
      return true;
    });

    filtered.sort((a, b) =>
      `${a.firstName} ${a.lastName}`.localeCompare(`${b.firstName} ${b.lastName}`),
    );

    const rows = filtered
      .slice(page.skip, page.skip + page.take)
      .map(({ reach, ...row }) => ({
        ...row,
        reach: reach === null ? 'ENTIRE_ENTERPRISE' : { siteCount: reach.length },
      }));

    return {
      ...paginate(rows, filtered.length, page),
      summary: {
        total: withinReach.length,
        active: withinReach.filter((r) => r.status === 'ACTIVE').length,
        invited: withinReach.filter((r) => r.status === 'INVITED').length,
        deactivated: withinReach.filter((r) => r.status === 'DEACTIVATED').length,
      },
    };
  }

  /**
   * Roles & Permissions.
   *
   * Read from the same table that gates every request, so the screen cannot
   * promise something the guards refuse. `youMayAssign` is what the Add User
   * form should offer — no more.
   */
  async listRoles(caller: Jwtpayload) {
    await this.scope.assertPermission(caller, PERMISSION.USERS_VIEW);

    const callerRole = await this.scope.getEnterpriseRole(caller);
    const assignable = assignableRolesFor(callerRole);
    const matrix = rolesMatrix();

    return {
      yourRole: callerRole,
      yourRoleLabel: callerRole ? this.roleLabel(callerRole) : null,
      youMayAssign: assignable,
      permissions: matrix.permissions,
      roles: matrix.roles.map((r) => ({
        ...r,
        youMayAssign: assignable.includes(r.role),
      })),
    };
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
    const existing = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { firstName: true, lastName: true, email: true, phoneNumber: true },
    });

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
        if (isUnrestricted(dto.role)) {
          await tx.userScope.deleteMany({ where: { userId, organisationId: orgId } });
        }
      }
    });

    const previousRole =
      membership.enterpriseRole ?? this.legacyRole(membership.orgRole);
    const changed = EnterpriseAuditService.diff(
      {
        firstName: existing.firstName,
        lastName: existing.lastName,
        mobile: existing.phoneNumber,
        role: previousRole,
      },
      {
        firstName: dto.firstName,
        lastName: dto.lastName,
        mobile: dto.mobile,
        role: dto.role,
      },
    );

    if (changed) {
      await this.audit.recordFor(caller, {
        organisationId: orgId,
        area: AuditArea.USERS,
        action: dto.role ? 'user.role_changed' : 'user.updated',
        entityType: 'User',
        entityId: userId,
        entityLabel: existing.email,
        previousValue: changed.previous,
        newValue: changed.next,
        summary: dto.role
          ? `${existing.firstName} ${existing.lastName} changed from ` +
            `${roleLabel(previousRole)} to ${roleLabel(dto.role)}`
          : `${existing.firstName} ${existing.lastName} updated ` +
            `(${Object.keys(changed.next).join(', ')})`,
      });
    }

    return this.getUser(caller, userId);
  }

  /** Replaces a user's scope grants wholesale. */
  async setScopes(caller: Jwtpayload, userId: number, dto: SetUserScopesDto) {
    const orgId = await this.assertUserAdmin(caller);
    const membership = await this.requireMembership(userId, orgId);

    const role = membership.enterpriseRole ?? this.legacyRole(membership.orgRole);
    if (isUnrestricted(role)) {
      throw new BadRequestException(
        `A ${roleLabel(role)} already covers the entire Enterprise and cannot be scoped.`,
      );
    }

    const scopes = this.normaliseScopes(role, dto.scopes);
    this.assertScopeSatisfiesRole(role, scopes);
    await this.assertScopesWithinCallerReach(caller, orgId, scopes);
    await this.assertScopeTargetsExist(orgId, scopes);

    const before = await this.prisma.userScope.findMany({
      where: { userId, organisationId: orgId },
      select: { scopeType: true, scopeId: true },
    });

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

    const target = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { firstName: true, lastName: true, email: true },
    });
    const targetName = target
      ? `${target.firstName} ${target.lastName}`.trim()
      : `User ${userId}`;
    const labels = await this.scopeLabels(orgId);
    const describe = (list: Array<{ scopeType: ScopeType; scopeId?: number | null }>) =>
      list.map(
        (sc) => labels.get(`${sc.scopeType}:${sc.scopeId ?? ''}`) ?? `${sc.scopeType}`,
      );

    await this.audit.recordFor(caller, {
      organisationId: orgId,
      area: AuditArea.USERS,
      action: 'user.access_changed',
      entityType: 'User',
      entityId: userId,
      entityLabel: target?.email ?? targetName,
      previousValue: { scopes: describe(before) },
      newValue: { scopes: describe(scopes) },
      summary: scopes.length
        ? `${targetName} scoped to ${describe(scopes).join(', ')}`
        : `All scope grants removed from ${targetName}`,
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

    const user = await this.prisma.user.update({
      where: { id: userId },
      data: { isActive },
      select: { firstName: true, lastName: true, email: true },
    });

    await this.audit.recordFor(caller, {
      organisationId: orgId,
      area: AuditArea.USERS,
      action: isActive ? 'user.activated' : 'user.deactivated',
      entityType: 'User',
      entityId: userId,
      entityLabel: user.email,
      previousValue: { isActive: !isActive },
      newValue: { isActive },
      summary: `${user.firstName} ${user.lastName} ${
        isActive ? 'activated' : 'deactivated'
      }`,
    });

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
    return this.scope.assertPermission(caller, PERMISSION.USERS_MANAGE);
  }

  /**
   * Nobody may grant a role above their own.
   *
   * The answer comes from the same table the Roles & Permissions screen
   * renders, so what that screen promises and what this allows cannot drift
   * apart.
   */
  private async assertCanGrantRole(caller: Jwtpayload, role: EnterpriseRole) {
    if (!isPortalRole(role)) {
      throw new BadRequestException({
        error: ENTERPRISE_ERROR.ROLE_NOT_OFFERED,
        message:
          `${roleLabel(role)} is a legacy role and can no longer be assigned. ` +
          `The portal defines five roles.`,
      });
    }

    const callerRole = await this.scope.getEnterpriseRole(caller);
    const assignable = assignableRolesFor(callerRole);

    if (!assignable.includes(role)) {
      throw new ForbiddenException({
        error: ENTERPRISE_ERROR.ROLE_NOT_ASSIGNABLE,
        message: callerRole
          ? `A ${roleLabel(callerRole)} cannot assign the ${roleLabel(role)} role.`
          : 'You are not a member of this Enterprise.',
        assignableRoles: assignable,
      });
    }
  }

  /**
   * A scoped role with no scope grants sees nothing at all, which is never
   * what the administrator meant — so it is rejected rather than saved.
   */
  private assertScopeSatisfiesRole(role: EnterpriseRole, scopes: ScopeGrantDto[]) {
    if (isUnrestricted(role)) return;
    if (scopes.length) return;

    throw new BadRequestException({
      error: ENTERPRISE_ERROR.SCOPE_REQUIRED,
      message:
        `A ${roleLabel(role)} only sees what they are scoped to. Assign at least one ` +
        `Group, Territory, Cluster or Site.`,
    });
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

  /**
   * Roles that already cover the whole Enterprise are implicitly unrestricted,
   * so explicit grants on them are noise and get dropped.
   */
  private normaliseScopes(
    role: EnterpriseRole,
    scopes?: ScopeGrantDto[],
  ): ScopeGrantDto[] {
    if (isUnrestricted(role)) return [];
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
    return roleLabel(role);
  }

  /**
   * Every scope target in the organisation resolved to its site ids, in one
   * pass.
   *
   * The listing needs each person's reach, and resolving scopes person by
   * person would be a query per row. This builds the lookup once and the rows
   * read from it.
   */
  private async scopeSiteIndex(orgId: number): Promise<Map<string, number[]>> {
    const [groupSites, clusterSites, territorySites, sites] = await Promise.all([
      this.prisma.groupSite.findMany({
        where: { organisationId: orgId },
        select: { groupId: true, siteId: true },
      }),
      this.prisma.clusterSite.findMany({
        where: { cluster: { organisationId: orgId } },
        select: { clusterId: true, siteId: true },
      }),
      this.prisma.territorySite.findMany({
        where: { territory: { organisationId: orgId } },
        select: { territoryId: true, siteId: true },
      }),
      this.prisma.site.findMany({
        where: { organisationId: orgId },
        select: { id: true },
      }),
    ]);

    const index = new Map<string, number[]>();
    const add = (key: string, siteId: number) => {
      const list = index.get(key);
      if (list) list.push(siteId);
      else index.set(key, [siteId]);
    };

    groupSites.forEach((r) => add(`GROUP:${r.groupId}`, r.siteId));
    clusterSites.forEach((r) => add(`CLUSTER:${r.clusterId}`, r.siteId));
    territorySites.forEach((r) => add(`TERRITORY:${r.territoryId}`, r.siteId));
    sites.forEach((s) => add(`SITE:${s.id}`, s.id));
    index.set(
      'ENTERPRISE:',
      sites.map((s) => s.id),
    );
    return index;
  }

  /**
   * One person's reach, or null for the whole Enterprise.
   *
   * Mirrors `EnterpriseScopeService.getAllowedSiteIds` — including the fall
   * back to the sites they operate on when they hold no explicit grant — but
   * reads from the prebuilt index instead of querying per user.
   */
  private reachFrom(
    role: EnterpriseRole,
    grants: Array<{ scopeType: ScopeType; scopeId: number | null }>,
    fallbackSiteIds: number[],
    index: Map<string, number[]>,
  ): number[] | null {
    if (isUnrestricted(role)) return null;
    if (!grants.length) return fallbackSiteIds;

    const reach = new Set<number>();
    for (const grant of grants) {
      if (grant.scopeType === ScopeType.ENTERPRISE) return null;
      const key = `${grant.scopeType}:${grant.scopeId ?? ''}`;
      (index.get(key) ?? []).forEach((siteId) => reach.add(siteId));
    }
    return [...reach];
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
