import { Injectable, NotFoundException } from '@nestjs/common';
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

  async getOrganisation(organisationId: number) {
    const organisation = await this.prisma.organisation.findFirst({
      where: { id: organisationId, enterpriseProfile: { is: null } },
      include: {
        subscription: { select: { status: true, plan: { select: { displayName: true } } } },
        orgMemeberShips: {
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
          },
          orderBy: { joinedAt: 'asc' },
        },
      },
    });
    if (!organisation) throw new NotFoundException('App organisation not found');

    const [sites, listings, inboundClaims] = await Promise.all([
      this.prisma.site.findMany({
        where: { organisationId },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          name: true,
          organisationName: true,
          address: true,
          postcode: true,
          contactName: true,
          contactEmail: true,
          contactMobile: true,
          isActive: true,
          createdAt: true,
        },
      }),
      this.prisma.foodListing.findMany({
        where: { organisationId },
        orderBy: { createdAt: 'desc' },
        include: {
          foodItems: true,
          site: { select: { id: true, name: true, organisationName: true, address: true } },
          foodClaims: {
            include: {
              claimantOrg: { select: { id: true, name: true, organizationType: true } },
              claimItems: true,
              driverPickups: {
                orderBy: { createdAt: 'desc' },
                take: 1,
                include: {
                  driver: { select: { id: true, firstName: true, lastName: true, email: true, phoneNumber: true } },
                },
              },
            },
          },
        },
      }),
      this.prisma.foodClaim.findMany({
        where: { claimantOrgId: organisationId },
        orderBy: { createdAt: 'desc' },
        include: {
          listing: {
            select: {
              id: true,
              status: true,
              pickupAddress: true,
              pickupFromTime: true,
              pickupByTime: true,
              organisation: { select: { id: true, name: true } },
              site: { select: { id: true, name: true, organisationName: true } },
              foodItems: { select: { name: true } },
            },
          },
          claimItems: true,
          driverPickups: {
            orderBy: { createdAt: 'desc' },
            take: 1,
            include: {
              driver: { select: { id: true, firstName: true, lastName: true, email: true, phoneNumber: true } },
            },
          },
        },
      }),
    ]);

    const mappedListings = listings.map((listing) => this.shapeListing(listing));
    const listingCounts = {
      all: mappedListings.length,
      ACTIVE: mappedListings.filter((row) => row.status === 'ACTIVE').length,
      PARTIAL: mappedListings.filter((row) => row.status === 'PARTIAL').length,
      CLAIMED: mappedListings.filter((row) => row.status === 'CLAIMED').length,
      EXPIRED: mappedListings.filter((row) => row.status === 'EXPIRED').length,
      CANCELLED: mappedListings.filter((row) => row.status === 'CANCELLED').length,
    };

    return {
      organisation: {
        id: organisation.id,
        name: organisation.name,
        organisationType: organisation.organizationType,
        organisationTypeLabel: TYPE_LABEL[organisation.organizationType],
        region: organisation.region,
        venueType: organisation.venueType,
        address: organisation.address,
        brandName: organisation.brandName,
        createdAt: organisation.createdAt,
        plan: organisation.subscription?.plan.displayName ?? null,
        subscriptionStatus: organisation.subscription?.status ?? null,
      },
      members: organisation.orgMemeberShips.map((row) => ({
        id: row.user.id,
        name: `${row.user.firstName} ${row.user.lastName}`.trim(),
        email: row.user.email,
        mobile: row.user.phoneNumber,
        orgRole: row.orgRole,
        status: !row.user.isActive
          ? 'Deactivated'
          : row.user.lastLoginAt
            ? 'Active'
            : row.user.emailVerified
              ? 'Never signed in'
              : 'Unverified',
        lastLoginAt: row.user.lastLoginAt,
        joinedAt: row.joinedAt,
      })),
      sites: sites.map((site) => ({
        id: site.id,
        name: site.name || site.organisationName,
        address: site.address,
        postcode: site.postcode,
        contactName: site.contactName,
        contactEmail: site.contactEmail,
        contactMobile: site.contactMobile,
        isActive: site.isActive,
        createdAt: site.createdAt,
      })),
      listings: mappedListings,
      listingCounts,
      collections: inboundClaims.map((claim) => this.shapeInboundClaim(claim)),
    };
  }

  private shapeListing(listing: {
    id: number;
    status: string;
    listingType: string;
    totalQtyKg: number;
    remainingQtyKg: number;
    pickupAddress: string;
    pickupPostcode: string | null;
    pickupFromTime: Date | null;
    pickupByTime: Date | null;
    bestBefore: Date;
    createdAt: Date;
    foodItems: Array<{ name: string; totalQtyKg: number; remainingQtyKg: number; unit: string | null; category: string | null }>;
    site: { id: number; name: string | null; organisationName: string; address: string };
    foodClaims: Array<{
      id: number;
      status: string;
      claimMode: string;
      createdAt: Date;
      collectedAt: Date | null;
      confirmedAt: Date | null;
      claimantOrg: { id: number; name: string; organizationType: OrgType };
      claimItems: Array<{ qtyKg: number }>;
      driverPickups: Array<{
        status: string;
        collectedAt: Date | null;
        driver: { id: number; firstName: string; lastName: string; email: string; phoneNumber: string };
      }>;
    }>;
  }) {
    return {
      id: listing.id,
      status: listing.status,
      listingType: listing.listingType,
      totalQtyKg: listing.totalQtyKg,
      remainingQtyKg: listing.remainingQtyKg,
      pickupAddress: listing.pickupAddress,
      pickupPostcode: listing.pickupPostcode,
      pickupFromTime: listing.pickupFromTime,
      pickupByTime: listing.pickupByTime,
      bestBefore: listing.bestBefore,
      createdAt: listing.createdAt,
      site: {
        id: listing.site.id,
        name: listing.site.name || listing.site.organisationName,
        address: listing.site.address,
      },
      items: listing.foodItems.map((item) => ({
        name: item.name,
        totalQtyKg: item.totalQtyKg,
        remainingQtyKg: item.remainingQtyKg,
        unit: item.unit,
        category: item.category,
      })),
      claims: listing.foodClaims.map((claim) => this.shapeClaim(claim)),
    };
  }

  private shapeInboundClaim(claim: {
    id: number;
    status: string;
    claimMode: string;
    createdAt: Date;
    collectedAt: Date | null;
    confirmedAt: Date | null;
    claimItems: Array<{ qtyKg: number }>;
    listing: {
      id: number;
      status: string;
      pickupAddress: string;
      pickupFromTime: Date | null;
      pickupByTime: Date | null;
      organisation: { id: number; name: string };
      site: { id: number; name: string | null; organisationName: string };
      foodItems: Array<{ name: string }>;
    };
    driverPickups: Array<{
      status: string;
      collectedAt: Date | null;
      driver: { id: number; firstName: string; lastName: string; email: string; phoneNumber: string };
    }>;
  }) {
    return {
      ...this.shapeClaim(claim),
      listingId: claim.listing.id,
      listingStatus: claim.listing.status,
      providerName: claim.listing.organisation.name,
      pickupAddress: claim.listing.pickupAddress,
      pickupFromTime: claim.listing.pickupFromTime,
      pickupByTime: claim.listing.pickupByTime,
      food: claim.listing.foodItems.map((item) => item.name).filter(Boolean).join(', ') || 'Listing',
      siteName: claim.listing.site.name || claim.listing.site.organisationName,
    };
  }

  private shapeClaim(claim: {
    id: number;
    status: string;
    claimMode: string;
    createdAt: Date;
    collectedAt: Date | null;
    confirmedAt: Date | null;
    claimantOrg?: { id: number; name: string; organizationType: OrgType };
    claimItems: Array<{ qtyKg: number }>;
    driverPickups: Array<{
      status: string;
      collectedAt: Date | null;
      driver: { id: number; firstName: string; lastName: string; email: string; phoneNumber: string };
    }>;
  }) {
    const driver = claim.driverPickups[0];
    const collectedKg = claim.claimItems.reduce((sum, item) => sum + item.qtyKg, 0);
    return {
      id: claim.id,
      status: claim.status,
      claimMode: claim.claimMode,
      collectedKg,
      createdAt: claim.createdAt,
      confirmedAt: claim.confirmedAt,
      collectedAt: claim.collectedAt ?? driver?.collectedAt ?? null,
      claimant: claim.claimantOrg
        ? {
            id: claim.claimantOrg.id,
            name: claim.claimantOrg.name,
            type: TYPE_LABEL[claim.claimantOrg.organizationType],
          }
        : null,
      collectedBy: claim.claimantOrg?.name ?? null,
      driver: driver
        ? {
            id: driver.driver.id,
            name: `${driver.driver.firstName} ${driver.driver.lastName}`.trim(),
            email: driver.driver.email,
            mobile: driver.driver.phoneNumber,
            status: driver.status,
          }
        : null,
    };
  }
}
