import {
  BadRequestException, ForbiddenException, Injectable, NotFoundException,
} from '@nestjs/common';
import { ClaimKind, ConsolidatedMemberRole, OrgRole } from '@prisma/client';
import { SiteRole } from '@prisma/client';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { Jwtpayload } from '../../auth/interface/jwt.interface';
import { assertNotViewOnly } from '../../enterprise/enterprise.permissions';
import { CONSOLIDATED_ERROR } from '../consolidated.errors';
import {
  CONSOLIDATED_ACTION, ConsolidatedAuditService, RequestContext,
} from './consolidated-audit.service';

/**
 * Every permission decision for Consolidated Collections.
 *
 * No controller or other service decides access for itself — they call in
 * here. One place to read, one place to test, one place to change.
 */
@Injectable()
export class ConsolidatedAccessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: ConsolidatedAuditService,
  ) {}

  // ─── Commercial gate ───────────────────────────────────────────────────────

  /**
   * The single commercial gate for this feature (SPEC R4).
   *
   * It does nothing today: the global SubscriptionInterceptor already returns
   * 402 for a billable org with no live plan, and the feature is included on
   * every paid plan with no module condition. It exists so that if the
   * commercial rule ever changes — module-gated, tier-gated — exactly one
   * method moves, instead of auditing every controller.
   *
   * Every public entry point calls this first.
   */
  assertProductAccess(_caller: Jwtpayload): void {
    // Intentionally empty. See SPEC R4 and BACKEND_GUIDE §B3.
  }

  // ─── Who the caller is ─────────────────────────────────────────────────────

  private orgId(caller: Jwtpayload): number {
    if (!caller.orgId) {
      throw new ForbiddenException('You are not a member of an organisation.');
    }
    return caller.orgId;
  }

  private isOrgOwner(caller: Jwtpayload): boolean {
    return caller.orgRole === OrgRole.SUPER_ADMIN;
  }

  private isOrgAdmin(caller: Jwtpayload): boolean {
    return caller.orgRole === OrgRole.SUPER_ADMIN || caller.orgRole === OrgRole.ORG_ADMIN;
  }

  /**
   * Sites the caller can reach, or `null` meaning "every site in the org".
   *
   * Null rather than a materialised list, so an org admin's reach does not go
   * stale the moment a site is added.
   */
  async callerSiteIds(caller: Jwtpayload): Promise<number[] | null> {
    if (this.isOrgAdmin(caller)) return null;
    const rows = await this.prisma.siteAccess.findMany({
      where: { userId: caller.sub, organisationId: this.orgId(caller) },
      select: { siteId: true },
    });
    return rows.map((r) => r.siteId);
  }

  /** Whether the caller may manage collections at all (R1, A1). */
  async canManageFlag(caller: Jwtpayload): Promise<boolean> {
    if (!caller.orgId) return false;
    // The org owner always holds it, without a membership row saying so.
    if (this.isOrgOwner(caller)) return true;

    const membership = await this.prisma.orgMemeberShip.findUnique({
      where: { userId_organisationId: { userId: caller.sub, organisationId: caller.orgId } },
      select: { canManageConsolidated: true },
    });
    if (!membership?.canManageConsolidated) return false;

    // The flag only means something on top of an admin role: an org admin, or
    // a site admin somewhere in this organisation.
    if (this.isOrgAdmin(caller)) return true;

    const siteAdmin = await this.prisma.siteAccess.count({
      where: { userId: caller.sub, organisationId: caller.orgId, siteRole: SiteRole.SITE_ADMIN },
    });
    return siteAdmin > 0;
  }

  async assertCanManage(caller: Jwtpayload): Promise<void> {
    this.assertProductAccess(caller);
    assertNotViewOnly(caller);
    if (!(await this.canManageFlag(caller))) {
      throw new ForbiddenException({
        error: CONSOLIDATED_ERROR.NOT_A_MANAGER,
        message: 'You do not have permission to manage collections.',
      });
    }
  }

  // ─── Groups ────────────────────────────────────────────────────────────────

  /** Every site must be live, in this org, and within the caller's reach. */
  async assertCanCreateGroup(caller: Jwtpayload, siteIds: number[]): Promise<void> {
    await this.assertCanManage(caller);
    if (siteIds.length === 0) {
      throw new ForbiddenException('Choose at least one site.');
    }

    const reach = await this.callerSiteIds(caller);
    const sites = await this.prisma.site.findMany({
      where: { id: { in: siteIds }, organisationId: this.orgId(caller), isActive: true },
      select: { id: true },
    });

    const found = new Set(sites.map((s) => s.id));
    const missing = siteIds.filter((id) => !found.has(id));
    if (missing.length > 0) {
      throw new NotFoundException(`Site ${missing[0]} is not an active site in your organisation.`);
    }

    if (reach !== null) {
      const allowed = new Set(reach);
      const outside = siteIds.filter((id) => !allowed.has(id));
      if (outside.length > 0) {
        throw new ForbiddenException({
          error: CONSOLIDATED_ERROR.SITE_OUT_OF_SCOPE,
          message: 'You can only use sites you administer.',
          siteIds: outside,
        });
      }
    }
  }

  /**
   * A manager of this group.
   *
   * A site admin's reach has to still cover every *active* site in the group —
   * losing access to one site means losing the group, not partial control of it.
   */
  async assertManager(caller: Jwtpayload, groupId: number) {
    await this.assertCanManage(caller);

    const group = await this.prisma.consolidatedGroup.findFirst({
      where: { id: groupId, organisationId: this.orgId(caller) },
      include: {
        members: { where: { userId: caller.sub }, select: { role: true } },
        sites: { where: { removedAt: null }, select: { siteId: true, invitationStatus: true } },
      },
    });
    if (!group) throw new NotFoundException('Collection group not found.');

    if (!this.isOrgOwner(caller)) {
      const isManager = group.members.some((m) => m.role === ConsolidatedMemberRole.MANAGER);
      if (!isManager) {
        throw new ForbiddenException({
          error: CONSOLIDATED_ERROR.NOT_A_MANAGER,
          message: 'You do not manage this collection group.',
        });
      }

      const reach = await this.callerSiteIds(caller);
      if (reach !== null) {
        const allowed = new Set(reach);
        if (group.sites.some((s) => !allowed.has(s.siteId))) {
          throw new ForbiddenException({
            error: CONSOLIDATED_ERROR.SITE_OUT_OF_SCOPE,
            message: 'This group includes sites you do not administer.',
          });
        }
      }
    }

    return group;
  }

  /** A manager, or someone trusted to confirm receipt at the point (R2). */
  async assertReceiver(caller: Jwtpayload, groupId: number) {
    this.assertProductAccess(caller);
    assertNotViewOnly(caller);

    const group = await this.prisma.consolidatedGroup.findFirst({
      where: { id: groupId, organisationId: this.orgId(caller) },
      include: { members: { where: { userId: caller.sub }, select: { role: true } } },
    });
    if (!group) throw new NotFoundException('Collection group not found.');

    if (this.isOrgOwner(caller)) return group;
    if (group.members.length > 0) return group;

    throw new ForbiddenException({
      error: CONSOLIDATED_ERROR.NOT_A_RECEIVER,
      message: 'You are not assigned to this collection group.',
    });
  }

  // ─── Sites ─────────────────────────────────────────────────────────────────

  /** Someone who may list food for this site. View-only roles may not. */
  async assertSiteUser(caller: Jwtpayload, siteId: number): Promise<void> {
    this.assertProductAccess(caller);
    assertNotViewOnly(caller);

    const site = await this.prisma.site.findFirst({
      where: { id: siteId, organisationId: this.orgId(caller) },
      select: { id: true },
    });
    if (!site) throw new NotFoundException('Site not found.');

    if (this.isOrgOwner(caller)) return;

    const access = await this.prisma.siteAccess.findUnique({
      where: { userId_siteId: { userId: caller.sub, siteId } },
      select: { id: true },
    });
    if (!access) {
      throw new ForbiddenException({
        error: CONSOLIDATED_ERROR.SITE_OUT_OF_SCOPE,
        message: 'You do not have access to this site.',
      });
    }
  }

  /** A site may only contribute to a collection it was invited to. */
  assertSiteParticipates(
    collection: { participatingSiteIds: number[] },
    siteId: number,
  ): void {
    if (!collection.participatingSiteIds.includes(siteId)) {
      throw new ForbiddenException({
        error: CONSOLIDATED_ERROR.SITE_NOT_PARTICIPATING,
        message: 'This site is not part of that collection.',
      });
    }
  }

  // ─── Charity ───────────────────────────────────────────────────────────────

  /** The claiming charity, and only on a master claim. */
  async assertCharityOwnsClaim(caller: Jwtpayload, claimId: number) {
    this.assertProductAccess(caller);

    const claim = await this.prisma.foodClaim.findFirst({
      where: {
        id: claimId,
        claimantOrgId: this.orgId(caller),
        claimKind: ClaimKind.CONSOLIDATED_MASTER,
      },
    });
    if (!claim) throw new NotFoundException('Claim not found.');
    return claim;
  }

  // ─── Summary for the client ────────────────────────────────────────────────

  /**
   * Powers `GET /consolidated/me` — what this user may do, so the client can
   * decide what to show without guessing at roles.
   */
  async meSummary(caller: Jwtpayload) {
    const canManage = await this.canManageFlag(caller);
    const reach = await this.callerSiteIds(caller);

    const memberships = caller.orgId
      ? await this.prisma.consolidatedGroupMember.findMany({
          where: { userId: caller.sub, group: { organisationId: caller.orgId, isActive: true } },
          select: { groupId: true, role: true, group: { select: { name: true } } },
        })
      : [];

    return {
      canManage,
      /** null means every site in the organisation. */
      siteIds: reach,
      groups: memberships.map((m) => ({
        groupId: m.groupId,
        name: m.group.name,
        role: m.role,
      })),
    };
  }

  // ─── Managing the permission itself ────────────────────────────────────────

  /** Only the org owner decides who may manage collections (SPEC R1). */
  private assertOrgOwner(caller: Jwtpayload): number {
    const orgId = this.orgId(caller);
    if (!this.isOrgOwner(caller)) {
      throw new ForbiddenException('Only the organisation owner can change this permission.');
    }
    return orgId;
  }

  async listPermissions(caller: Jwtpayload) {
    const orgId = this.assertOrgOwner(caller);

    const memberships = await this.prisma.orgMemeberShip.findMany({
      where: { organisationId: orgId },
      include: { user: { select: { id: true, firstName: true, lastName: true, email: true } } },
    });

    const siteAdmins = new Set(
      (
        await this.prisma.siteAccess.findMany({
          where: { organisationId: orgId, siteRole: SiteRole.SITE_ADMIN },
          select: { userId: true },
        })
      ).map((r) => r.userId),
    );

    return memberships
      .map((m) => ({
        userId: m.user.id,
        name: `${m.user.firstName} ${m.user.lastName}`.trim(),
        email: m.user.email,
        orgRole: m.orgRole,
        isSiteAdmin: siteAdmins.has(m.user.id),
        canManageConsolidated: m.canManageConsolidated || m.orgRole === OrgRole.SUPER_ADMIN,
        /** The owner's permission is implicit and cannot be withdrawn. */
        isImplicit: m.orgRole === OrgRole.SUPER_ADMIN,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Grants or withdraws the permission.
   *
   * Withdrawing it also drops the user's manager memberships — leaving them
   * named as a manager they can no longer act as would be a lie on screen.
   */
  async setPermission(
    caller: Jwtpayload,
    userId: number,
    canManage: boolean,
    req?: RequestContext,
  ) {
    const orgId = this.assertOrgOwner(caller);

    const membership = await this.prisma.orgMemeberShip.findUnique({
      where: { userId_organisationId: { userId, organisationId: orgId } },
      include: { user: { select: { firstName: true, lastName: true, email: true } } },
    });
    if (!membership) throw new NotFoundException('User is not a member of this organisation.');

    if (membership.orgRole === OrgRole.SUPER_ADMIN) {
      throw new BadRequestException('The organisation owner always has this permission.');
    }

    if (canManage) {
      const isSiteAdmin = await this.prisma.siteAccess.count({
        where: { userId, organisationId: orgId, siteRole: SiteRole.SITE_ADMIN },
      });
      if (membership.orgRole !== OrgRole.ORG_ADMIN && isSiteAdmin === 0) {
        throw new BadRequestException('User must be an Org Admin or Site Admin.');
      }
    }

    const actor = await this.audit.actorFrom(caller, req);
    const name = `${membership.user.firstName} ${membership.user.lastName}`.trim();

    return this.prisma.$transaction(async (tx) => {
      await tx.orgMemeberShip.update({
        where: { userId_organisationId: { userId, organisationId: orgId } },
        data: { canManageConsolidated: canManage },
      });

      let removedFrom = 0;
      if (!canManage) {
        const result = await tx.consolidatedGroupMember.deleteMany({
          where: {
            userId,
            role: ConsolidatedMemberRole.MANAGER,
            group: { organisationId: orgId },
          },
        });
        removedFrom = result.count;
      }

      await this.audit.log(tx, actor, {
        organisationId: orgId,
        action: CONSOLIDATED_ACTION.PERMISSION_CHANGED,
        entityType: 'User',
        entityId: userId,
        entityLabel: name,
        previousValue: { canManageConsolidated: membership.canManageConsolidated },
        newValue: { canManageConsolidated: canManage },
        summary: canManage
          ? `Granted ${name} permission to manage collections.`
          : `Withdrew ${name}'s permission to manage collections` +
            (removedFrom ? `, removing them from ${removedFrom} group(s).` : '.'),
      });

      return { userId, canManageConsolidated: canManage, removedFromGroups: removedFrom };
    });
  }
}
