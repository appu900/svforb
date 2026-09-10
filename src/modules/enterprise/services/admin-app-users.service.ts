import { Injectable } from '@nestjs/common';
import { OrgType, PlatformRole } from '@prisma/client';
import { PrismaService } from '../../../infra/prisma/prisma.service';

const TYPE_LABEL: Record<OrgType, string> = {
  BUSINESS_SINGLE: 'Restaurant single',
  BUSINESS_MULTI: 'Restaurant multi',
  CHARITY: 'Charity single',
  CHARITY_SINGLE: 'Charity single',
  CHARITY_MULTI: 'Charity multi',
  FARMER_PRODUCER: 'Farmer producer',
  FARMER_CONSUMER: 'Farmer consumer',
};

@Injectable()
export class AdminAppUsersService {
  constructor(private readonly prisma: PrismaService) {}

  async list() {
    const memberships = await this.prisma.orgMemeberShip.findMany({
      where: {
        organisation: { enterpriseProfile: { is: null } },
        user: { platformRole: { not: PlatformRole.PLATFORM_ADMIN } },
      },
      include: {
        user: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
            phoneNumber: true,
            region: true,
            isActive: true,
            emailVerified: true,
            lastLoginAt: true,
            createdAt: true,
          },
        },
        organisation: {
          select: {
            id: true,
            name: true,
            organizationType: true,
            region: true,
            venueType: true,
            createdAt: true,
            subscription: {
              select: {
                status: true,
                plan: { select: { displayName: true, name: true } },
              },
            },
          },
        },
      },
      orderBy: { joinedAt: 'desc' },
    });

    const users = memberships.map((row) => {
      const status = !row.user.isActive
        ? 'Deactivated'
        : row.user.lastLoginAt
          ? 'Active'
          : row.user.emailVerified
            ? 'Never signed in'
            : 'Unverified';
      return {
        id: row.user.id,
        firstName: row.user.firstName,
        lastName: row.user.lastName,
        name: `${row.user.firstName} ${row.user.lastName}`.trim(),
        email: row.user.email,
        mobile: row.user.phoneNumber,
        region: row.user.region ?? row.organisation.region ?? null,
        status,
        emailVerified: row.user.emailVerified,
        lastLoginAt: row.user.lastLoginAt,
        createdAt: row.user.createdAt,
        joinedAt: row.joinedAt,
        orgRole: row.orgRole,
        organisationId: row.organisation.id,
        organisationName: row.organisation.name,
        organisationType: row.organisation.organizationType,
        organisationTypeLabel: TYPE_LABEL[row.organisation.organizationType],
        venueType: row.organisation.venueType,
        organisationCreatedAt: row.organisation.createdAt,
        plan: row.organisation.subscription?.plan.displayName ?? null,
        subscriptionStatus: row.organisation.subscription?.status ?? null,
      };
    });

    const counts = {
      all: users.length,
      business_single: users.filter((row) => row.organisationType === 'BUSINESS_SINGLE').length,
      business_multi: users.filter((row) => row.organisationType === 'BUSINESS_MULTI').length,
      charity_single: users.filter((row) =>
        row.organisationType === 'CHARITY_SINGLE' || row.organisationType === 'CHARITY',
      ).length,
      charity_multi: users.filter((row) => row.organisationType === 'CHARITY_MULTI').length,
      farmer_producer: users.filter((row) => row.organisationType === 'FARMER_PRODUCER').length,
      farmer_consumer: users.filter((row) => row.organisationType === 'FARMER_CONSUMER').length,
    };

    return { users, counts };
  }
}
