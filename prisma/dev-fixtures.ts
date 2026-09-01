// Must precede any TLS use — mirrors src/main.ts, the Aiven cert is self-signed.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
import 'dotenv/config';
import {
  BillingCycle,
  OrgRole,
  OrgType,
  PlatformRole,
  PrismaClient,
  Region,
  SiteRole,
  SubscriptionStatus,
  VenueType,
} from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { createPgPool } from '../src/infra/prisma/create-pg-pool';
import * as bcrypt from 'bcrypt';

/**
 * Local / Play Store review fixtures.
 *
 * Creates a platform admin plus one billable org per region.
 * Idempotent — re-running updates the existing users rather than duplicating.
 *
 *   npx ts-node --compiler-options '{"module":"CommonJS"}' prisma/dev-fixtures.ts
 */

const PASSWORD = 'Test1234!';

const LOCATIONS = {
  AU: {
    address: '35 Market Street, South Melbourne VIC 3205',
    postcode: '3205',
    latitude: -37.8315,
    longitude: 144.9603,
  },
  IN: {
    address: 'Connaught Place, New Delhi, Delhi 110001',
    postcode: '110001',
    latitude: 28.6328,
    longitude: 77.2197,
  },
} as const;

const pool = createPgPool();
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

async function upsertUser(email: string, platformRole: PlatformRole, region?: Region) {
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  return prisma.user.upsert({
    where: { email },
    create: {
      firstName: 'Dev',
      lastName: 'User',
      email,
      passwordHash,
      phoneNumber: '0400000000',
      platformRole,
      region,
      emailVerified: true,
      isActive: true,
    },
    update: {
      passwordHash,
      platformRole,
      region,
      emailVerified: true,
      isActive: true,
    },
  });
}

async function syncPostgis(orgId: number, siteId: number, lat: number, lng: number) {
  await prisma.$executeRaw`
    UPDATE organisations
    SET location = ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography
    WHERE id = ${orgId}
  `;
  await prisma.$executeRaw`
    UPDATE sites
    SET location = ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography
    WHERE id = ${siteId}
  `;
}

async function grantSingleSiteAccess(orgId: number, planName = 'SINGLE_SITE_PLUS') {
  const plan = await prisma.subscriptionPlan.findUnique({
    where: { name: planName },
  });
  if (!plan) {
    console.log(`  no ${planName} plan — run prisma/seed.ts so the dummy is billable`);
    return;
  }

  const now = new Date();
  const ends = new Date(now);
  ends.setFullYear(ends.getFullYear() + 1);

  await prisma.orgSubscription.upsert({
    where: { organisationId: orgId },
    create: {
      organisationId: orgId,
      planId: plan.id,
      status: SubscriptionStatus.ACTIVE,
      billingCycle: BillingCycle.ANNUAL,
      currentPeriodStart: now,
      currentPeriodEnd: ends,
      quantity: 1,
    },
    update: {
      planId: plan.id,
      status: SubscriptionStatus.ACTIVE,
      currentPeriodStart: now,
      currentPeriodEnd: ends,
    },
  });
}

async function createOrg(email: string, orgType: OrgType, region: Region, name: string) {
  const loc = LOCATIONS[region];
  const existing = await prisma.user.findUnique({
    where: { email },
    include: { orgMemeberShips: true },
  });

  if (existing?.orgMemeberShips.length) {
    const orgId = existing.orgMemeberShips[0].organisationId;
    const site = await prisma.site.findFirst({
      where: { organisationId: orgId },
      orderBy: { createdAt: 'asc' },
    });

    await prisma.organisation.update({
      where: { id: orgId },
      data: {
        address: loc.address,
        latitude: loc.latitude,
        longitude: loc.longitude,
        venueType: VenueType.CAFE_RESTAURANT,
        region,
      },
    });

    if (site) {
      await prisma.site.update({
        where: { id: site.id },
        data: {
          address: loc.address,
          postcode: loc.postcode,
          latitude: loc.latitude,
          longitude: loc.longitude,
        },
      });
      await syncPostgis(orgId, site.id, loc.latitude, loc.longitude);
    }

    if (orgType === OrgType.BUSINESS_SINGLE) {
      await grantSingleSiteAccess(orgId, 'SINGLE_SITE_PLUS');
    }

    console.log(
      `  ${name.padEnd(16)} location backfilled org=${orgId} ` +
        `lat=${loc.latitude} lng=${loc.longitude} (${region})`,
    );
    return;
  }

  const user = await upsertUser(email, PlatformRole.ORG_USER, region);
  const org = await prisma.organisation.create({
    data: {
      name,
      organizationType: orgType,
      address: loc.address,
      region,
      latitude: loc.latitude,
      longitude: loc.longitude,
      venueType: VenueType.CAFE_RESTAURANT,
    },
  });
  await prisma.orgMemeberShip.create({
    data: { userId: user.id, organisationId: org.id, orgRole: OrgRole.SUPER_ADMIN },
  });
  const site = await prisma.site.create({
    data: {
      organisationId: org.id,
      organisationName: name,
      name,
      address: loc.address,
      postcode: loc.postcode,
      contactName: 'Dev User',
      contactEmail: email,
      contactMobile: '0400000000',
      latitude: loc.latitude,
      longitude: loc.longitude,
    },
  });
  await prisma.siteAccess.create({
    data: {
      userId: user.id,
      siteId: site.id,
      organisationId: org.id,
      siteRole: SiteRole.SITE_ADMIN,
      grantedBy: user.id,
    },
  });
  await syncPostgis(org.id, site.id, loc.latitude, loc.longitude);

  if (orgType === OrgType.BUSINESS_SINGLE) {
    await grantSingleSiteAccess(org.id, 'SINGLE_SITE_PLUS');
  }

  console.log(
    `  ${name.padEnd(16)} org=${org.id} site=${site.id} ` +
      `lat=${loc.latitude} lng=${loc.longitude} (${orgType})`,
  );
}

async function removeOtherFixtureUsers() {
  const extras = await prisma.user.findMany({
    where: {
      email: { in: ['admin@dev.local', 'in@dev.local', 'multi@dev.local'] },
    },
    include: { orgMemeberShips: true },
  });

  for (const user of extras) {
    const orgIds = user.orgMemeberShips.map((m) => m.organisationId);
    await prisma.siteAccess.deleteMany({
      where: { OR: [{ userId: user.id }, { organisationId: { in: orgIds } }] },
    });
    if (orgIds.length) {
      await prisma.site.deleteMany({ where: { organisationId: { in: orgIds } } });
      await prisma.orgMemeberShip.deleteMany({
        where: { organisationId: { in: orgIds } },
      });
      await prisma.orgSubscription.deleteMany({
        where: { organisationId: { in: orgIds } },
      });
      await prisma.organisation.deleteMany({ where: { id: { in: orgIds } } });
    }
    await prisma.user.delete({ where: { id: user.id } });
    console.log(`  removed ${user.email}`);
  }
}

async function main() {
  await removeOtherFixtureUsers();
  await createOrg('au@dev.local', OrgType.BUSINESS_SINGLE, Region.AU, 'AU Test Cafe');
  console.log(`\n  Play Store dummy: au@dev.local / ${PASSWORD}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
