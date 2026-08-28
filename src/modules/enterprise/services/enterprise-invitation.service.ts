import {
  BadRequestException,
  ConflictException,
  GoneException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AuditArea,
  EnterpriseRole,
  InvitationStatus,
  OrgRole,
  PlatformRole,
  Prisma,
  ScopeType,
  SiteRole,
} from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { EmailQueueService } from '../../notifications/queues/email.queue.service';
import { ENTERPRISE_ERROR } from '../enterprise.constants';
import { AuditActor, EnterpriseAuditService } from './enterprise-audit.service';

/** How long an activation link stays usable. */
export const INVITATION_TTL_HOURS = 72;

/** The version of the T&Cs a user accepts at activation. */
export const TERMS_VERSION = 'saveful-for-business-2026-08';

export interface IssueInvitationInput {
  organisationId: number;
  email: string;
  firstName: string;
  lastName: string;
  mobile?: string | null;
  role: EnterpriseRole;
  scopes: Array<{ scopeType: ScopeType; scopeId: number | null }>;
  /** Set when the invite comes from Add Site — grants site access on acceptance. */
  siteAdminForSiteId?: number | null;
  invitedBy: number;
}

/**
 * Secure, time-limited account activation.
 *
 * Administrators never create passwords on behalf of users. The invitation
 * holds the assigned Role and Scope in escrow; acceptance is what creates the
 * account and copies them across, so a link that is never opened leaves no
 * half-provisioned user behind.
 */
@Injectable()
export class EnterpriseInvitationService {
  private readonly logger = new Logger(EnterpriseInvitationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly email: EmailQueueService,
    private readonly audit: EnterpriseAuditService,
  ) {}

  // ─── Issuing ───────────────────────────────────────────────────────────────

  /**
   * Creates an invitation and emails the link.
   *
   * Any earlier pending invitation for the same address is revoked first —
   * resending must invalidate the previous activation link, and two live links
   * for one person is exactly the ambiguity that rule exists to prevent.
   */
  async issue(input: IssueInvitationInput, actor?: AuditActor) {
    const email = input.email.trim().toLowerCase();

    const existing = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true, orgMemeberShips: { select: { organisationId: true } } },
    });

    if (existing) {
      const elsewhere = existing.orgMemeberShips.some(
        (m) => m.organisationId !== input.organisationId,
      );
      if (elsewhere) {
        throw new ConflictException(
          'That email already belongs to a different organisation',
        );
      }
      const alreadyHere = existing.orgMemeberShips.some(
        (m) => m.organisationId === input.organisationId,
      );
      if (alreadyHere) {
        throw new ConflictException(
          'That person is already a member of this Enterprise. Edit their access instead.',
        );
      }
    }

    const { token, tokenHash } = this.mintToken();
    const expiresAt = new Date(Date.now() + INVITATION_TTL_HOURS * 3600_000);

    const invitation = await this.prisma.$transaction(async (tx) => {
      await tx.enterpriseInvitation.updateMany({
        where: {
          organisationId: input.organisationId,
          email,
          status: InvitationStatus.PENDING,
        },
        data: { status: InvitationStatus.REVOKED, revokedAt: new Date() },
      });

      return tx.enterpriseInvitation.create({
        data: {
          organisationId: input.organisationId,
          email,
          firstName: input.firstName,
          lastName: input.lastName,
          mobile: input.mobile ?? null,
          enterpriseRole: input.role,
          siteAdminForSiteId: input.siteAdminForSiteId ?? null,
          tokenHash,
          expiresAt,
          invitedBy: input.invitedBy,
          scopes: {
            create: input.scopes.map((s) => ({
              scopeType: s.scopeType,
              scopeId: s.scopeId,
            })),
          },
        },
        include: { organisation: { select: { name: true } } },
      });
    });

    await this.sendInviteEmail(invitation.id, token, {
      email,
      firstName: input.firstName,
      role: input.role,
      organisationName: invitation.organisation.name,
      expiresAt,
    });

    if (actor) {
      await this.audit.record(actor, {
        organisationId: input.organisationId,
        area: AuditArea.USERS,
        action: 'user.invited',
        entityType: 'EnterpriseInvitation',
        entityId: invitation.id,
        entityLabel: email,
        newValue: { role: input.role, scopes: input.scopes.length },
        summary: `${input.firstName} ${input.lastName} invited as ${this.roleLabel(input.role)}`,
      });
    }

    this.logger.log(
      `invitation issued: id=${invitation.id} org=${input.organisationId} role=${input.role}`,
    );

    return { invitationId: invitation.id, email, expiresAt };
  }

  /** Reissues the link for a pending invitation, invalidating the previous one. */
  async resend(organisationId: number, invitationId: number, actor?: AuditActor) {
    const invitation = await this.prisma.enterpriseInvitation.findFirst({
      where: { id: invitationId, organisationId },
      include: {
        scopes: { select: { scopeType: true, scopeId: true } },
        organisation: { select: { name: true } },
      },
    });
    if (!invitation) throw new NotFoundException('Invitation not found');

    if (invitation.status === InvitationStatus.ACCEPTED) {
      throw new ConflictException({
        error: ENTERPRISE_ERROR.INVITATION_ALREADY_ACCEPTED,
        message: 'That invitation has already been used. The user can sign in.',
      });
    }

    const { token, tokenHash } = this.mintToken();
    const expiresAt = new Date(Date.now() + INVITATION_TTL_HOURS * 3600_000);

    const updated = await this.prisma.enterpriseInvitation.update({
      where: { id: invitationId },
      data: {
        tokenHash,
        expiresAt,
        status: InvitationStatus.PENDING,
        sentAt: new Date(),
        revokedAt: null,
      },
    });

    await this.sendInviteEmail(updated.id, token, {
      email: updated.email,
      firstName: updated.firstName,
      role: updated.enterpriseRole,
      organisationName: invitation.organisation.name,
      expiresAt,
    });

    if (actor) {
      await this.audit.record(actor, {
        organisationId,
        area: AuditArea.USERS,
        action: 'user.invitation_resent',
        entityType: 'EnterpriseInvitation',
        entityId: invitationId,
        entityLabel: updated.email,
        summary: `Invitation resent to ${updated.email}; previous link invalidated`,
      });
    }

    return { invitationId, email: updated.email, expiresAt };
  }

  async revoke(organisationId: number, invitationId: number, actor?: AuditActor) {
    const invitation = await this.prisma.enterpriseInvitation.findFirst({
      where: { id: invitationId, organisationId },
    });
    if (!invitation) throw new NotFoundException('Invitation not found');
    if (invitation.status === InvitationStatus.ACCEPTED) {
      throw new ConflictException('That invitation has already been used');
    }

    await this.prisma.enterpriseInvitation.update({
      where: { id: invitationId },
      data: { status: InvitationStatus.REVOKED, revokedAt: new Date() },
    });

    if (actor) {
      await this.audit.record(actor, {
        organisationId,
        area: AuditArea.USERS,
        action: 'user.invitation_revoked',
        entityType: 'EnterpriseInvitation',
        entityId: invitationId,
        entityLabel: invitation.email,
        summary: `Invitation to ${invitation.email} revoked`,
      });
    }

    return { message: 'Invitation revoked' };
  }

  // ─── Activation ────────────────────────────────────────────────────────────

  /**
   * What the activation screen renders before the user sets a password: the
   * Enterprise and Role they were invited to, and a locked email field.
   *
   * Each failure mode is distinct so the client can route correctly — an
   * already-accepted invitation sends the user to sign in, an expired one
   * offers a resend.
   */
  async describe(token: string) {
    const invitation = await this.findByToken(token);

    if (invitation.status === InvitationStatus.ACCEPTED) {
      throw new ConflictException({
        error: ENTERPRISE_ERROR.INVITATION_ALREADY_ACCEPTED,
        message: 'This account is already active. Please sign in.',
      });
    }
    if (invitation.status === InvitationStatus.REVOKED) {
      throw new GoneException({
        error: ENTERPRISE_ERROR.INVITATION_INVALID,
        message: 'This invitation is no longer valid. Ask your administrator to send a new one.',
      });
    }
    if (invitation.expiresAt <= new Date()) {
      await this.prisma.enterpriseInvitation.update({
        where: { id: invitation.id },
        data: { status: InvitationStatus.EXPIRED },
      });
      throw new GoneException({
        error: ENTERPRISE_ERROR.INVITATION_EXPIRED,
        message: 'This invitation has expired. Ask your administrator to send a new one.',
      });
    }

    return {
      email: invitation.email,
      firstName: invitation.firstName,
      lastName: invitation.lastName,
      enterprise: invitation.organisation.name,
      role: this.roleLabel(invitation.enterpriseRole),
      expiresAt: invitation.expiresAt,
      termsVersion: TERMS_VERSION,
    };
  }

  /**
   * Creates the account, applies the escrowed role and scope, and marks the
   * invitation used — all in one transaction, so a failure part-way cannot
   * leave a user who exists but can see nothing.
   */
  async accept(token: string, password: string, acceptedTerms: boolean) {
    if (!acceptedTerms) {
      throw new BadRequestException(
        'You must accept the Terms & Conditions to activate your account',
      );
    }

    // Re-runs every validity check; `describe` is only a preview.
    await this.describe(token);
    const invitation = await this.findByToken(token);

    const passwordHash = await bcrypt.hash(password, 10);
    const now = new Date();

    const user = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.user.findUnique({
        where: { email: invitation.email },
      });

      const account = existing
        ? await tx.user.update({
            where: { id: existing.id },
            data: {
              passwordHash,
              isActive: true,
              emailVerified: true,
              termsAcceptedAt: now,
              termsVersion: TERMS_VERSION,
            },
          })
        : await tx.user.create({
            data: {
              firstName: invitation.firstName,
              lastName: invitation.lastName,
              email: invitation.email,
              passwordHash,
              phoneNumber: invitation.mobile ?? '',
              platformRole: PlatformRole.ORG_USER,
              emailVerified: true,
              isActive: true,
              termsAcceptedAt: now,
              termsVersion: TERMS_VERSION,
            },
          });

      await tx.orgMemeberShip.upsert({
        where: {
          userId_organisationId: {
            userId: account.id,
            organisationId: invitation.organisationId,
          },
        },
        create: {
          userId: account.id,
          organisationId: invitation.organisationId,
          orgRole:
            invitation.enterpriseRole === EnterpriseRole.SUPER_ADMIN
              ? OrgRole.SUPER_ADMIN
              : OrgRole.ORG_MEMBER,
          enterpriseRole: invitation.enterpriseRole,
        },
        update: { enterpriseRole: invitation.enterpriseRole },
      });

      if (invitation.scopes.length) {
        await tx.userScope.deleteMany({
          where: { userId: account.id, organisationId: invitation.organisationId },
        });
        await tx.userScope.createMany({
          data: invitation.scopes.map((s) => ({
            userId: account.id,
            organisationId: invitation.organisationId,
            scopeType: s.scopeType,
            scopeId: s.scopeId,
            grantedBy: invitation.invitedBy,
          })),
          skipDuplicates: true,
        });
      }

      // An invitation raised from Add Site also grants operational access.
      if (invitation.siteAdminForSiteId) {
        await tx.siteAccess.upsert({
          where: {
            userId_siteId: {
              userId: account.id,
              siteId: invitation.siteAdminForSiteId,
            },
          },
          create: {
            userId: account.id,
            siteId: invitation.siteAdminForSiteId,
            organisationId: invitation.organisationId,
            siteRole: SiteRole.SITE_ADMIN,
            grantedBy: invitation.invitedBy,
          },
          update: { siteRole: SiteRole.SITE_ADMIN },
        });
      }

      await tx.enterpriseInvitation.update({
        where: { id: invitation.id },
        data: {
          status: InvitationStatus.ACCEPTED,
          acceptedAt: now,
          acceptedUserId: account.id,
        },
      });

      return account;
    });

    await this.audit.record(
      {
        userId: user.id,
        name: `${user.firstName} ${user.lastName}`.trim(),
        email: user.email,
      },
      {
        organisationId: invitation.organisationId,
        area: AuditArea.AUTH,
        action: 'user.activated',
        entityType: 'User',
        entityId: user.id,
        entityLabel: user.email,
        newValue: { role: invitation.enterpriseRole, termsVersion: TERMS_VERSION },
        summary: `${user.firstName} ${user.lastName} activated their account`,
      },
    );

    this.logger.log(
      `invitation accepted: id=${invitation.id} user=${user.id} org=${invitation.organisationId}`,
    );

    return {
      message: 'Account activated. You can now sign in.',
      userId: user.id,
      email: user.email,
      enterprise: invitation.organisation.name,
      role: this.roleLabel(invitation.enterpriseRole),
    };
  }

  // ─── Reading ───────────────────────────────────────────────────────────────

  /** Pending invitations for a user listing, keyed by lowercase email. */
  async pendingByEmail(
    organisationId: number,
  ): Promise<Map<string, { id: number; sentAt: Date; expiresAt: Date }>> {
    const rows = await this.prisma.enterpriseInvitation.findMany({
      where: { organisationId, status: InvitationStatus.PENDING },
      select: { id: true, email: true, sentAt: true, expiresAt: true },
    });
    return new Map(rows.map((r) => [r.email, r]));
  }

  /** Marks lapsed invitations expired. Called by the daily enterprise cron. */
  async expireLapsedInvitations(): Promise<number> {
    const { count } = await this.prisma.enterpriseInvitation.updateMany({
      where: { status: InvitationStatus.PENDING, expiresAt: { lte: new Date() } },
      data: { status: InvitationStatus.EXPIRED },
    });
    if (count) this.logger.log(`expired ${count} lapsed invitation(s)`);
    return count;
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  /**
   * The raw token never touches the database — only its hash — so a database
   * leak cannot be replayed into account takeovers.
   */
  private mintToken(): { token: string; tokenHash: string } {
    const token = randomBytes(32).toString('base64url');
    return { token, tokenHash: this.hash(token) };
  }

  private hash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private async findByToken(token: string) {
    const invitation = await this.prisma.enterpriseInvitation.findUnique({
      where: { tokenHash: this.hash(token) },
      include: {
        scopes: { select: { scopeType: true, scopeId: true } },
        organisation: { select: { name: true } },
      },
    });
    if (!invitation) {
      throw new NotFoundException({
        error: ENTERPRISE_ERROR.INVITATION_INVALID,
        message: 'That invitation link is not valid.',
      });
    }
    return invitation;
  }

  private async sendInviteEmail(
    invitationId: number,
    token: string,
    meta: {
      email: string;
      firstName: string;
      role: EnterpriseRole;
      organisationName: string;
      expiresAt: Date;
    },
  ): Promise<void> {
    // Invite links must open the Enterprise website, not the API host.
    // APP_URL stays the API (billing/webhooks). FRONTEND_URL is this portal.
    const frontendUrl = this.config.get<string>('FRONTEND_URL');
    const appUrl = frontendUrl || this.config.get<string>('APP_URL', 'http://localhost:3000');
    const link = `${appUrl.replace(/\/$/, '')}/activate?token=${token}`;

    await this.email
      .sendEnterpriseInvite({
        to: meta.email,
        name: meta.firstName,
        enterpriseName: meta.organisationName,
        role: this.roleLabel(meta.role),
        activationUrl: link,
        expiresInHours: INVITATION_TTL_HOURS,
      })
      .catch((err) =>
        this.logger.warn(
          `invitation email failed (id=${invitationId}): ${(err as Error).message}`,
        ),
      );
  }

  private roleLabel(role: EnterpriseRole): string {
    const map: Record<EnterpriseRole, string> = {
      SUPER_ADMIN: 'Enterprise Super Admin',
      ENTERPRISE_ADMIN: 'Enterprise Admin',
      GROUP_ADMIN: 'Group Admin',
      REPORTING_USER: 'Reporting User',
      SITE_ADMIN: 'Site Admin',
      CLUSTER_ADMIN: 'Cluster Admin',
      SITE_USER: 'Site User',
    };
    return map[role];
  }
}

/** Kept for callers that need the Prisma payload shape. */
export type InvitationWithScopes = Prisma.EnterpriseInvitationGetPayload<{
  include: { scopes: true; organisation: { select: { name: true } } };
}>;
