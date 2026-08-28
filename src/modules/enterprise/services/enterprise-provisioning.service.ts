import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditArea,
  EnterpriseAccountStatus,
  EnterpriseRole,
  MeasurementUnit,
  OrgType,
  Region,
  ScopeType,
  SubscriptionStatus,
} from '@prisma/client';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { Jwtpayload } from '../../auth/interface/jwt.interface';
import {
  ProvisionEnterpriseDto,
  UpdateProvisioningDto,
} from '../dto/enterprise.dto';
import { ENTERPRISE_ERROR, ENTERPRISE_PLAN_NAME } from '../enterprise.constants';
import { EnterpriseAuditService } from './enterprise-audit.service';
import { EnterpriseInvitationService } from './enterprise-invitation.service';

/** Currency defaults by country, so the admin form does not have to ask twice. */
const CURRENCY_BY_COUNTRY: Record<string, string> = {
  AU: 'AUD',
  IN: 'INR',
  NZ: 'NZD',
  GB: 'GBP',
  US: 'USD',
};

/**
 * Enterprise accounts are created and provisioned by Saveful. They are not
 * self-created by Enterprise customers, and this deliberately lives outside the
 * customer-facing portal — every method here is platform-admin only.
 */
@Injectable()
export class EnterpriseProvisioningService {
  private readonly logger = new Logger(EnterpriseProvisioningService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly invitations: EnterpriseInvitationService,
    private readonly audit: EnterpriseAuditService,
  ) {}

  /**
   * Creates the Enterprise account and invites its first Super Admin.
   *
   * The organisation, its profile and the ENTERPRISE plan are written in one
   * transaction: an organisation that exists without the plan would fail every
   * `assertEnterprise()` check and be invisible in the portal it was created
   * for. The invitation is sent afterwards, so a bounced email leaves a usable
   * Enterprise rather than rolling the whole thing back.
   */
  async provision(caller: Jwtpayload, dto: ProvisionEnterpriseDto) {
    const plan = await this.prisma.subscriptionPlan.findUnique({
      where: { name: ENTERPRISE_PLAN_NAME },
      select: { id: true },
    });
    if (!plan) {
      throw new NotFoundException(
        'The ENTERPRISE plan is missing from the catalogue. Run the seed first.',
      );
    }

    const country = dto.country.trim().toUpperCase();
    const enterpriseId = dto.enterpriseId?.trim().toUpperCase()
      ?? (await this.nextEnterpriseId(country));

    const clash = await this.prisma.enterpriseProfile.findUnique({
      where: { enterpriseId },
      select: { organisationId: true },
    });
    if (clash) {
      throw new ConflictException({
        error: ENTERPRISE_ERROR.ENTERPRISE_ID_TAKEN,
        message: `Enterprise ID ${enterpriseId} is already in use.`,
      });
    }

    const adminEmail = dto.adminEmail.trim().toLowerCase();
    const existingUser = await this.prisma.user.findUnique({
      where: { email: adminEmail },
      select: { orgMemeberShips: { select: { organisationId: true } } },
    });
    if (existingUser?.orgMemeberShips.length) {
      throw new ConflictException(
        'That email already belongs to an organisation. Use a different Super Admin.',
      );
    }

    const currency = (
      dto.currency ?? CURRENCY_BY_COUNTRY[country] ?? 'AUD'
    ).toUpperCase();

    const organisation = await this.prisma.$transaction(async (tx) => {
      const org = await tx.organisation.create({
        data: {
          name: dto.enterpriseName,
          // Enterprise runs on the multi-site model; the plan is what marks it.
          organizationType: OrgType.BUSINESS_MULTI,
          address: dto.address,
          region: dto.region ?? this.regionForCountry(country),
          logoUrl: dto.logoUrl ?? null,
        },
      });

      await tx.enterpriseProfile.create({
        data: {
          organisationId: org.id,
          enterpriseId,
          accountStatus: EnterpriseAccountStatus.PENDING,
          country,
          timezone: dto.timezone,
          currency,
          measurementUnit: dto.measurementUnit ?? MeasurementUnit.METRIC,
          primaryContactName: `${dto.adminFirstName} ${dto.adminLastName}`.trim(),
          primaryContactEmail: adminEmail,
          primaryContactPhone: dto.adminMobile ?? null,
          logoUrl: dto.logoUrl ?? null,
        },
      });

      await tx.orgSubscription.upsert({
        where: { organisationId: org.id },
        create: {
          organisationId: org.id,
          planId: plan.id,
          status: SubscriptionStatus.ACTIVE,
        },
        update: { planId: plan.id, status: SubscriptionStatus.ACTIVE },
      });

      return org;
    });

    const invitation = await this.invitations.issue({
      organisationId: organisation.id,
      email: adminEmail,
      firstName: dto.adminFirstName,
      lastName: dto.adminLastName,
      mobile: dto.adminMobile ?? null,
      role: EnterpriseRole.SUPER_ADMIN,
      scopes: [{ scopeType: ScopeType.ENTERPRISE, scopeId: null }],
      invitedBy: caller.sub,
    });

    await this.audit.recordFor(caller, {
      organisationId: organisation.id,
      area: AuditArea.ENTERPRISE_SETTINGS,
      action: 'enterprise.provisioned',
      entityType: 'Organisation',
      entityId: organisation.id,
      entityLabel: organisation.name,
      newValue: { enterpriseId, country, currency },
      summary: `Enterprise ${organisation.name} provisioned as ${enterpriseId}`,
    });

    this.logger.log(
      `enterprise provisioned: org=${organisation.id} id=${enterpriseId} by=${caller.sub}`,
    );

    return {
      message:
        'Enterprise created. An activation invitation has been sent to the Super Admin.',
      organisationId: organisation.id,
      enterpriseId,
      accountStatus: EnterpriseAccountStatus.PENDING,
      superAdminInvitation: invitation,
      nextStep:
        'Create the Enterprise contract to set the rate and billing frequency.',
    };
  }

  /** Every Enterprise, for the Saveful admin listing. */
  async list() {
    const profiles = await this.prisma.enterpriseProfile.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        organisation: {
          select: {
            id: true,
            name: true,
            _count: { select: { orgMemeberShips: true } },
          },
        },
      },
    });

    const orgIds = profiles.map((p) => p.organisationId);

    // Site carries an organisationId but no back-relation, so `_count` cannot
    // reach it — group instead.
    const siteCounts = await this.prisma.site.groupBy({
      by: ['organisationId'],
      where: { organisationId: { in: orgIds } },
      _count: { _all: true },
    });
    const sitesByOrg = new Map(
      siteCounts.map((s) => [s.organisationId, s._count._all]),
    );

    const contracts = await this.prisma.enterpriseContract.findMany({
      where: { organisationId: { in: orgIds } },
      select: {
        organisationId: true,
        status: true,
        startDate: true,
        endDate: true,
        billingFrequency: true,
      },
    });
    const byOrg = new Map(contracts.map((c) => [c.organisationId, c]));

    return profiles.map((p) => ({
      organisationId: p.organisationId,
      enterpriseId: p.enterpriseId,
      name: p.organisation.name,
      accountStatus: p.accountStatus,
      country: p.country,
      currency: p.currency,
      sites: sitesByOrg.get(p.organisationId) ?? 0,
      users: p.organisation._count.orgMemeberShips,
      contract: byOrg.get(p.organisationId) ?? null,
    }));
  }

  async getOne(organisationId: number) {
    const profile = await this.prisma.enterpriseProfile.findUnique({
      where: { organisationId },
      include: { organisation: { select: { id: true, name: true, address: true } } },
    });
    if (!profile) throw new NotFoundException('Enterprise not found');

    const [contract, pendingInvites] = await Promise.all([
      this.prisma.enterpriseContract.findUnique({ where: { organisationId } }),
      this.prisma.enterpriseInvitation.count({
        where: { organisationId, status: 'PENDING' },
      }),
    ]);

    return { ...this.shape(profile), contract, pendingInvitations: pendingInvites };
  }

  /** Provisioning fields only — these stay read-only to Enterprise users. */
  async updateProvisioning(
    caller: Jwtpayload,
    organisationId: number,
    dto: UpdateProvisioningDto,
  ) {
    const before = await this.prisma.enterpriseProfile.findUnique({
      where: { organisationId },
    });
    if (!before) throw new NotFoundException('Enterprise not found');

    const after = await this.prisma.enterpriseProfile.update({
      where: { organisationId },
      data: {
        accountStatus: dto.accountStatus,
        country: dto.country?.trim().toUpperCase(),
        timezone: dto.timezone,
        currency: dto.currency?.toUpperCase(),
        measurementUnit: dto.measurementUnit,
      },
      include: { organisation: { select: { id: true, name: true, address: true } } },
    });

    const changed = EnterpriseAuditService.diff(
      before as unknown as Record<string, unknown>,
      dto as Record<string, unknown>,
    );
    if (changed) {
      await this.audit.recordFor(caller, {
        organisationId,
        area: AuditArea.ENTERPRISE_SETTINGS,
        action: 'enterprise.provisioning_updated',
        entityType: 'EnterpriseProfile',
        entityId: after.id,
        entityLabel: after.enterpriseId,
        previousValue: changed.previous,
        newValue: changed.next,
        summary: `Provisioning updated for ${after.organisation.name}`,
      });
    }

    return this.shape(after);
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  /**
   * Sequential per country: ENT-AU-000001, ENT-AU-000002. Derived from the
   * current count rather than a sequence, then collision-checked by the caller.
   */
  private async nextEnterpriseId(country: string): Promise<string> {
    const prefix = `ENT-${country}-`;
    const last = await this.prisma.enterpriseProfile.findFirst({
      where: { enterpriseId: { startsWith: prefix } },
      orderBy: { enterpriseId: 'desc' },
      select: { enterpriseId: true },
    });

    const n = last ? Number(last.enterpriseId.slice(prefix.length)) + 1 : 1;
    return `${prefix}${String(Number.isNaN(n) ? 1 : n).padStart(6, '0')}`;
  }

  private regionForCountry(country: string): Region | null {
    if (country === 'IN') return Region.IN;
    if (country === 'AU') return Region.AU;
    return null;
  }

  private shape(profile: {
    id: number;
    organisationId: number;
    enterpriseId: string;
    accountStatus: EnterpriseAccountStatus;
    country: string;
    timezone: string;
    currency: string;
    measurementUnit: MeasurementUnit;
    primaryContactName: string | null;
    primaryContactEmail: string | null;
    primaryContactPhone: string | null;
    logoUrl: string | null;
    organisation: { id: number; name: string; address: string };
  }) {
    return {
      organisationId: profile.organisationId,
      enterpriseId: profile.enterpriseId,
      name: profile.organisation.name,
      address: profile.organisation.address,
      accountStatus: profile.accountStatus,
      country: profile.country,
      timezone: profile.timezone,
      currency: profile.currency,
      measurementUnit: profile.measurementUnit,
      primaryContactName: profile.primaryContactName,
      primaryContactEmail: profile.primaryContactEmail,
      primaryContactPhone: profile.primaryContactPhone,
      logoUrl: profile.logoUrl,
    };
  }
}
