import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { AuditArea, EnterpriseRole } from '@prisma/client';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { Jwtpayload } from '../../auth/interface/jwt.interface';
import { UpdateEnterpriseProfileDto } from '../dto/enterprise.dto';
import { EnterpriseAuditService } from './enterprise-audit.service';
import { EnterpriseScopeService } from './enterprise-scope.service';

/** Roles permitted to edit organisation details. */
const PROFILE_EDITORS: EnterpriseRole[] = [
  EnterpriseRole.SUPER_ADMIN,
  EnterpriseRole.ENTERPRISE_ADMIN,
];

/**
 * Organisation Profile — the first page inside Enterprise Settings.
 *
 * The split matters: Enterprise ID, account status, contract dates and billing
 * frequency are established by Saveful and are read-only here. Contact details,
 * logo and reporting defaults belong to the customer.
 */
@Injectable()
export class EnterpriseProfileService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: EnterpriseScopeService,
    private readonly audit: EnterpriseAuditService,
  ) {}

  async get(caller: Jwtpayload) {
    const orgId = await this.scope.assertEnterprise(caller);

    const profile = await this.prisma.enterpriseProfile.findUnique({
      where: { organisationId: orgId },
      include: { organisation: { select: { name: true, address: true, logoUrl: true } } },
    });
    if (!profile) {
      throw new NotFoundException(
        'This Enterprise has no profile yet. Contact Saveful support.',
      );
    }

    const [contract, plan] = await Promise.all([
      this.prisma.enterpriseContract.findUnique({
        where: { organisationId: orgId },
        select: {
          startDate: true,
          endDate: true,
          billingFrequency: true,
          status: true,
        },
      }),
      this.prisma.orgSubscription.findUnique({
        where: { organisationId: orgId },
        select: { plan: { select: { displayName: true } } },
      }),
    ]);

    return {
      editable: {
        enterpriseName: profile.organisation.name,
        primaryContactName: profile.primaryContactName,
        primaryContactEmail: profile.primaryContactEmail,
        primaryContactPhone: profile.primaryContactPhone,
        logoUrl: profile.logoUrl ?? profile.organisation.logoUrl,
        timezone: profile.timezone,
        measurementUnit: profile.measurementUnit,
      },
      // Managed by Saveful — surfaced so the screen can render them locked.
      readOnly: {
        enterpriseId: profile.enterpriseId,
        accountStatus: profile.accountStatus,
        country: profile.country,
        currency: profile.currency,
        address: profile.organisation.address,
        contractStartDate: contract?.startDate ?? null,
        contractEndDate: contract?.endDate ?? null,
        billingFrequency: contract?.billingFrequency ?? null,
        contractStatus: contract?.status ?? null,
        enterprisePlan: plan?.plan.displayName ?? 'Enterprise',
      },
    };
  }

  async update(caller: Jwtpayload, dto: UpdateEnterpriseProfileDto) {
    const orgId = await this.scope.assertEnterprise(caller);

    const role = await this.scope.getEnterpriseRole(caller);
    if (!role || !PROFILE_EDITORS.includes(role)) {
      throw new ForbiddenException(
        'Only an Enterprise Super Admin or Enterprise Admin can edit organisation details.',
      );
    }

    const before = await this.prisma.enterpriseProfile.findUnique({
      where: { organisationId: orgId },
      include: { organisation: { select: { name: true } } },
    });
    if (!before) throw new NotFoundException('Enterprise profile not found');

    await this.prisma.$transaction(async (tx) => {
      await tx.enterpriseProfile.update({
        where: { organisationId: orgId },
        data: {
          primaryContactName: dto.primaryContactName,
          primaryContactEmail: dto.primaryContactEmail?.trim().toLowerCase(),
          primaryContactPhone: dto.primaryContactPhone,
          logoUrl: dto.logoUrl,
          timezone: dto.timezone,
          measurementUnit: dto.measurementUnit,
        },
      });

      // Name and logo also live on Organisation, which the mobile app reads.
      if (dto.enterpriseName || dto.logoUrl) {
        await tx.organisation.update({
          where: { id: orgId },
          data: {
            ...(dto.enterpriseName ? { name: dto.enterpriseName } : {}),
            ...(dto.logoUrl ? { logoUrl: dto.logoUrl } : {}),
          },
        });
      }
    });

    const changed = EnterpriseAuditService.diff(
      {
        enterpriseName: before.organisation.name,
        primaryContactName: before.primaryContactName,
        primaryContactEmail: before.primaryContactEmail,
        primaryContactPhone: before.primaryContactPhone,
        logoUrl: before.logoUrl,
        timezone: before.timezone,
        measurementUnit: before.measurementUnit,
      } as Record<string, unknown>,
      dto as Record<string, unknown>,
    );

    if (changed) {
      await this.audit.recordFor(caller, {
        organisationId: orgId,
        area: AuditArea.ENTERPRISE_SETTINGS,
        action: 'organisation_profile.updated',
        entityType: 'EnterpriseProfile',
        entityId: before.id,
        entityLabel: before.enterpriseId,
        previousValue: changed.previous,
        newValue: changed.next,
        summary: `Organisation profile updated (${Object.keys(changed.next).join(', ')})`,
      });
    }

    return this.get(caller);
  }
}
