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

    const accesses = memberships.length
      ? await this.prisma.siteAccess.findMany({
          where: {
            organisationId: { in: [...new Set(memberships.map((row) => row.organisationId))] },
            userId: { in: [...new Set(memberships.map((row) => row.user.id))] },
          },
          select: { userId: true, organisationId: true, siteRole: true },
        })
      : [];
    const siteRoleByMember = new Map<string, string>();
    for (const row of accesses) {
      const key = `${row.userId}:${row.organisationId}`;
      const current = siteRoleByMember.get(key);
      if (!current || current === 'DRIVER') siteRoleByMember.set(key, row.siteRole);
    }

    const members = memberships.map((row) => {
      const status = !row.user.isActive
        ? 'Deactivated'
        : row.user.lastLoginAt
          ? 'Active'
          : row.user.emailVerified
            ? 'Never signed in'
            : 'Unverified';
      const siteRole = siteRoleByMember.get(`${row.user.id}:${row.organisation.id}`) ?? null;
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
        siteRole,
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

    const users = this.directoryUsers(members);
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

    const appOrgs = await this.prisma.organisation.findMany({
      where: { enterpriseProfile: { is: null } },
      select: {
        id: true,
        name: true,
        organizationType: true,
        region: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });
    const appOrgIds = appOrgs.map((row) => row.id);
    const appSites = appOrgIds.length
      ? await this.prisma.site.findMany({
          where: { organisationId: { in: appOrgIds } },
          select: {
            id: true,
            organisationId: true,
            name: true,
            organisationName: true,
            address: true,
            postcode: true,
            isActive: true,
            createdAt: true,
            lastActivityAt: true,
          },
          orderBy: { createdAt: 'asc' },
        })
      : [];
    const sitesByOrg = new Map<number, typeof appSites>();
    for (const site of appSites) {
      const list = sitesByOrg.get(site.organisationId) ?? [];
      list.push(site);
      sitesByOrg.set(site.organisationId, list);
    }
    const usersByOrg = new Map<number, number>();
    for (const row of members) {
      usersByOrg.set(row.organisationId, (usersByOrg.get(row.organisationId) ?? 0) + 1);
    }

    const organisations = appOrgs.map((row) => {
      const sites = sitesByOrg.get(row.id) ?? [];
      return {
        id: row.id,
        name: row.name,
        organisationType: row.organizationType,
        organisationTypeLabel: TYPE_LABEL[row.organizationType],
        region: row.region,
        createdAt: row.createdAt,
        users: usersByOrg.get(row.id) ?? 0,
        siteCount: sites.length,
        activeSiteCount: sites.filter((site) => site.isActive).length,
      };
    });

    return {
      users,
      counts,
      organisations,
      sites: appSites.map((site) => ({
        id: site.id,
        organisationId: site.organisationId,
        name: site.name || site.organisationName,
        address: site.address,
        postcode: site.postcode,
        isActive: site.isActive,
        createdAt: site.createdAt,
        lastActivityAt: site.lastActivityAt,
      })),
    };
  }

  async getOrganisation(organisationId: number) {
    const organisation = await this.prisma.organisation.findFirst({
      where: { id: organisationId, enterpriseProfile: { is: null } },
      include: {
        subscription: { select: { status: true, plan: { select: { displayName: true } } } },
        siteAccesses: { select: { userId: true, siteId: true, siteRole: true } },
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
              claimantSite: { select: { id: true, name: true, organisationName: true } },
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
          claimantSite: { select: { id: true, name: true, organisationName: true } },
          listing: {
            select: {
              id: true,
              status: true,
              listingType: true,
              totalQtyKg: true,
              remainingQtyKg: true,
              pickupAddress: true,
              pickupPostcode: true,
              pickupFromTime: true,
              pickupByTime: true,
              bestBefore: true,
              createdAt: true,
              organisation: { select: { id: true, name: true, organizationType: true } },
              site: { select: { id: true, name: true, organisationName: true, address: true } },
              foodItems: { select: { name: true, totalQtyKg: true } },
            },
          },
          claimItems: { include: { foodItem: { select: { name: true, unit: true } } } },
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
      members: organisation.orgMemeberShips.map((row) => {
        const access = organisation.siteAccesses.filter((item) => item.userId === row.user.id);
        const siteRole =
          access.find((item) => item.siteRole !== 'DRIVER')?.siteRole ??
          access[0]?.siteRole ??
          null;
        return {
          id: row.user.id,
          name: `${row.user.firstName} ${row.user.lastName}`.trim(),
          email: row.user.email,
          mobile: row.user.phoneNumber,
          orgRole: row.orgRole,
          siteRole,
          siteIds: [...new Set(access.map((item) => item.siteId))],
          status: !row.user.isActive
            ? 'Deactivated'
            : row.user.lastLoginAt
              ? 'Active'
              : row.user.emailVerified
                ? 'Never signed in'
                : 'Unverified',
          lastLoginAt: row.user.lastLoginAt,
          joinedAt: row.joinedAt,
        };
      }),
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
      claimantSite?: { id: number; name: string | null; organisationName: string } | null;
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
    claimItems: Array<{ qtyKg: number; foodItem?: { name: string; unit: string | null } | null }>;
    listing: {
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
      organisation: { id: number; name: string; organizationType: OrgType };
      site: { id: number; name: string | null; organisationName: string; address: string };
      foodItems: Array<{ name: string; totalQtyKg: number }>;
    };
    driverPickups: Array<{
      status: string;
      collectedAt: Date | null;
      driver: { id: number; firstName: string; lastName: string; email: string; phoneNumber: string };
    }>;
  }) {
    const items = claim.claimItems.length
      ? claim.claimItems.map((item) => ({
          name: item.foodItem?.name || 'Item',
          totalQtyKg: item.qtyKg,
        }))
      : claim.listing.foodItems.map((item) => ({ name: item.name, totalQtyKg: item.totalQtyKg }));
    return {
      ...this.shapeClaim(claim),
      listingId: claim.listing.id,
      listingStatus: claim.listing.status,
      listingType: claim.listing.listingType,
      listingCreatedAt: claim.listing.createdAt,
      bestBefore: claim.listing.bestBefore,
      listingTotalKg: claim.listing.totalQtyKg,
      listingRemainingKg: claim.listing.remainingQtyKg,
      providerName: claim.listing.organisation.name,
      providerType: TYPE_LABEL[claim.listing.organisation.organizationType],
      pickupAddress: claim.listing.pickupAddress,
      pickupPostcode: claim.listing.pickupPostcode,
      pickupFromTime: claim.listing.pickupFromTime,
      pickupByTime: claim.listing.pickupByTime,
      food: items.map((item) => item.name).filter(Boolean).join(', ') || 'Listing',
      siteName: claim.listing.site.name || claim.listing.site.organisationName,
      siteAddress: claim.listing.site.address,
      items,
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
    claimantSite?: { id: number; name: string | null; organisationName: string } | null;
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
      claimantSiteId: claim.claimantSite?.id ?? null,
      collectedBy:
        claim.claimantSite?.name ||
        claim.claimantSite?.organisationName ||
        claim.claimantOrg?.name ||
        null,
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

  async listActivity() {
    const orgs = await this.prisma.organisation.findMany({
      where: { enterpriseProfile: { is: null } },
      select: { id: true, name: true, organizationType: true, createdAt: true },
    });
    const orgIds = orgs.map((row) => row.id);
    if (!orgIds.length) return { activity: [] };

    const orgById = new Map(orgs.map((row) => [row.id, row]));
    const [listings, claims, memberships, sites] = await Promise.all([
      this.prisma.foodListing.findMany({
        where: { organisationId: { in: orgIds } },
        orderBy: { createdAt: 'desc' },
        take: 500,
        select: {
          id: true,
          siteId: true,
          status: true,
          createdAt: true,
          organisationId: true,
          listingType: true,
          recoveryPathway: true,
          totalQtyKg: true,
          remainingQtyKg: true,
          pickupAddress: true,
          pickupPostcode: true,
          pickupFromTime: true,
          pickupByTime: true,
          bestBefore: true,
          site: { select: { name: true, organisationName: true } },
          foodItems: { select: { name: true, totalQtyKg: true }, take: 8 },
        },
      }),
      this.prisma.foodClaim.findMany({
        where: {
          OR: [{ claimantOrgId: { in: orgIds } }, { listing: { organisationId: { in: orgIds } } }],
        },
        orderBy: { createdAt: 'desc' },
        take: 500,
        select: {
          id: true,
          status: true,
          createdAt: true,
          collectedAt: true,
          confirmedAt: true,
          claimantOrgId: true,
          claimantSite: { select: { id: true, name: true, organisationName: true } },
          claimItems: { select: { qtyKg: true, foodItem: { select: { name: true } } } },
          listing: {
            select: {
              id: true,
              siteId: true,
              organisationId: true,
              totalQtyKg: true,
              remainingQtyKg: true,
              listingType: true,
              recoveryPathway: true,
              site: { select: { name: true } },
              foodItems: { select: { name: true, totalQtyKg: true }, take: 8 },
              organisation: { select: { name: true } },
            },
          },
          claimantOrg: { select: { id: true, name: true, organizationType: true } },
        },
      }),
      this.prisma.orgMemeberShip.findMany({
        where: {
          organisationId: { in: orgIds },
          user: { platformRole: { not: PlatformRole.PLATFORM_ADMIN } },
        },
        select: {
          organisationId: true,
          orgRole: true,
          joinedAt: true,
          user: {
            select: { id: true, firstName: true, lastName: true, lastLoginAt: true },
          },
        },
      }),
      this.prisma.site.findMany({
        where: { organisationId: { in: orgIds } },
        select: { id: true, organisationId: true, name: true, organisationName: true, createdAt: true },
      }),
    ]);

    const foodLabel = (items: Array<{ name: string }>) =>
      items.map((item) => item.name).filter(Boolean).join(', ') || 'Food listing';
    const pathwayOf = (listingType?: string | null, recoveryPathway?: string | null) => {
      if (recoveryPathway === 'LIVESTOCK_FEED') return 'livestock';
      if (recoveryPathway === 'CIRCULAR_RECOVERY') return 'circular';
      if (recoveryPathway === 'BIOENERGY') return 'bioenergy';
      if ((listingType || '').toUpperCase() === 'ANIMAL') return 'livestock';
      return 'people';
    };

    const activity: Array<{
      id: string;
      at: Date;
      kind: string;
      detail: string;
      organisationId: number;
      organisationName: string;
      organisationType: string;
    }> = [];

    for (const org of orgs) {
      activity.push({
        id: `app-org-${org.id}`,
        at: org.createdAt,
        kind: 'Organisation created',
        detail: `${org.name} · ${TYPE_LABEL[org.organizationType]}`,
        organisationId: org.id,
        organisationName: org.name,
        organisationType: org.organizationType,
      });
    }

    for (const site of sites) {
      const org = orgById.get(site.organisationId);
      if (!org) continue;
      activity.push({
        id: `app-site-${site.id}`,
        at: site.createdAt,
        kind: 'Site added',
        detail: `${site.name || site.organisationName} · ${org.name}`,
        organisationId: org.id,
        organisationName: org.name,
        organisationType: org.organizationType,
      });
    }

    for (const row of memberships) {
      const org = orgById.get(row.organisationId);
      if (!org) continue;
      const name = `${row.user.firstName} ${row.user.lastName}`.trim() || 'User';
      activity.push({
        id: `app-user-${row.user.id}-${org.id}`,
        at: row.joinedAt,
        kind: row.orgRole === 'SUPER_ADMIN' ? 'Account owner added' : 'User added',
        detail: `${name} · ${TYPE_LABEL[org.organizationType]}`,
        organisationId: org.id,
        organisationName: org.name,
        organisationType: org.organizationType,
      });
      if (row.user.lastLoginAt) {
        activity.push({
          id: `app-login-${row.user.id}-${org.id}`,
          at: row.user.lastLoginAt,
          kind: 'User signed in',
          detail: `${name} · ${TYPE_LABEL[org.organizationType]}`,
          organisationId: org.id,
          organisationName: org.name,
          organisationType: org.organizationType,
        });
      }
    }

    for (const listing of listings) {
      const org = orgById.get(listing.organisationId);
      if (!org) continue;
      const status = listing.status;
      const kind =
        status === 'EXPIRED'
          ? 'Listing expired'
          : status === 'CLAIMED' || status === 'PARTIAL'
            ? 'Listing claimed'
            : status === 'CANCELLED'
              ? 'Listing cancelled'
              : 'Listing published';
      activity.push({
        id: `app-list-${listing.id}`,
        at: listing.createdAt,
        kind,
        detail: `${listing.site?.name || listing.site?.organisationName || org.name} · ${foodLabel(listing.foodItems)}`,
        organisationId: org.id,
        organisationName: org.name,
        organisationType: org.organizationType,
      });
    }

    for (const claim of claims) {
      const claimant = claim.claimantOrg;
      const provider = orgById.get(claim.listing.organisationId);
      const at = claim.collectedAt ?? claim.confirmedAt ?? claim.createdAt;
      const food = foodLabel(claim.listing.foodItems);
      const siteName = claim.listing.site?.name || claim.listing.organisation.name;
      if (claimant && orgById.has(claimant.id)) {
        const kind =
          claim.status === 'COLLECTED'
            ? 'Collection completed'
            : claim.status === 'CONFIRMED'
              ? 'Collection confirmed'
              : claim.status === 'CANCELLED'
                ? 'Collection cancelled'
                : 'Collection claimed';
        activity.push({
          id: `app-col-${claim.id}-${claimant.id}`,
          at,
          kind,
          detail: `${siteName} · ${food}`,
          organisationId: claimant.id,
          organisationName: claimant.name,
          organisationType: claimant.organizationType,
        });
      }
      if (provider && provider.id !== claimant?.id) {
        const kind = claim.status === 'COLLECTED' ? 'Listing collected' : 'Listing claimed';
        activity.push({
          id: `app-col-${claim.id}-${provider.id}`,
          at,
          kind,
          detail: `${claimant?.name || 'Recipient'} · ${food}`,
          organisationId: provider.id,
          organisationName: provider.name,
          organisationType: provider.organizationType,
        });
      }
    }

    return {
      activity: activity
        .filter((row) => row.at)
        .sort((left, right) => right.at.getTime() - left.at.getTime())
        .slice(0, 400)
        .map((row) => ({
          ...row,
          at: row.at.toISOString(),
        })),
      listings: listings.map((listing) => ({
        id: listing.id,
        organisationId: listing.organisationId,
        siteId: listing.siteId,
        status: listing.status,
        createdAt: listing.createdAt,
        listingType: listing.listingType,
        recoveryPathway: listing.recoveryPathway,
        totalQtyKg: listing.totalQtyKg,
        remainingQtyKg: listing.remainingQtyKg,
        pickupAddress: listing.pickupAddress,
        pickupPostcode: listing.pickupPostcode,
        pickupFromTime: listing.pickupFromTime,
        pickupByTime: listing.pickupByTime,
        bestBefore: listing.bestBefore,
        food: foodLabel(listing.foodItems),
        foodItems: listing.foodItems,
      })),
      collections: claims.map((claim) => {
        const kg = claim.claimItems.reduce((sum, item) => sum + (item.qtyKg ?? 0), 0);
        return {
          id: claim.id,
          listingId: claim.listing.id,
          organisationId: claim.listing.organisationId,
          siteId: claim.listing.siteId,
          recipientOrgId: claim.claimantOrgId,
          recipientName:
            claim.claimantSite?.name ||
            claim.claimantSite?.organisationName ||
            claim.claimantOrg?.name ||
            'Recipient',
          status: claim.status,
          createdAt: claim.createdAt,
          collectedAt: claim.collectedAt,
          confirmedAt: claim.confirmedAt,
          quantityKg: kg || claim.listing.totalQtyKg || 0,
          listingTotalKg: claim.listing.totalQtyKg,
          listingRemainingKg: claim.listing.remainingQtyKg,
          food: foodLabel(claim.listing.foodItems.length ? claim.listing.foodItems : claim.claimItems.map((item) => ({ name: item.foodItem?.name || 'Item' }))),
          pathway: pathwayOf(claim.listing.listingType, claim.listing.recoveryPathway),
          providerName: claim.listing.organisation.name,
          siteName: claim.listing.site?.name || claim.listing.organisation.name,
        };
      }),
    };
  }

  private directoryUsers<T extends { organisationId: number; orgRole: string; siteRole?: string | null; joinedAt?: Date | string | null }>(
    members: T[],
  ): T[] {
    const accountHolders = members.filter((row) => this.isAccountHolder(row.orgRole, row.siteRole));
    const covered = new Set(accountHolders.map((row) => row.organisationId));
    const fallbacks = new Map<number, T>();
    for (const row of members) {
      if (covered.has(row.organisationId)) continue;
      const current = fallbacks.get(row.organisationId);
      if (!current) {
        fallbacks.set(row.organisationId, row);
        continue;
      }
      const currentJoined = current.joinedAt ? new Date(current.joinedAt).getTime() : Number.POSITIVE_INFINITY;
      const nextJoined = row.joinedAt ? new Date(row.joinedAt).getTime() : Number.POSITIVE_INFINITY;
      if (nextJoined < currentJoined) fallbacks.set(row.organisationId, row);
    }
    return [...accountHolders, ...fallbacks.values()];
  }

  private isAccountHolder(orgRole?: string | null, _siteRole?: string | null) {
    const role = (orgRole || '').toUpperCase();
    return role === 'SUPER_ADMIN' || role === 'ORG_ADMIN';
  }

}
