// Must precede any TLS use — mirrors src/main.ts, the Aiven cert is self-signed.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
import 'dotenv/config';
import { OrgRole, OrgType, PrismaClient, SiteRole } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import * as fs from 'fs';
import * as path from 'path';

/**
 * One-time backfill: CHARITY_MULTI orgs with zero sites get a head-office site
 * from the organisation address/coords so nearby/claim works after re-login.
 *
 *   npm run backfill:multi-hq-sites
 *   # or:
 *   npx ts-node --compiler-options '{"module":"CommonJS"}' prisma/backfill-multi-charity-hq-sites.ts
 */

const DEFAULT_PICKUP_RADIUS_KM = 50;

const caPath = path.join(process.cwd(), 'src/infra/prisma', 'ca.pem');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: fs.existsSync(caPath)
    ? { rejectUnauthorized: false, ca: fs.readFileSync(caPath).toString() }
    : undefined,
});
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

async function syncSiteLocation(siteId: number, lat: number, lng: number) {
  if (!lat || !lng) return;
  await prisma.$executeRaw`
    UPDATE sites
    SET location = ST_SetSRID(
      ST_MakePoint(${lng}, ${lat}), 4326
    )::geography
    WHERE id = ${siteId}
  `;
}

async function main() {
  const orgs = await prisma.organisation.findMany({
    where: {
      organizationType: OrgType.CHARITY_MULTI,
    },
    include: {
      orgMemeberShips: {
        where: { orgRole: OrgRole.SUPER_ADMIN },
        include: { user: true },
        take: 1,
      },
      charityPickupPrefs: true,
    },
  });

  let candidates = 0;
  let created = 0;

  for (const org of orgs) {
    const existingSites = await prisma.site.count({
      where: { organisationId: org.id },
    });
    if (existingSites > 0) continue;

    candidates += 1;
    const admin = org.orgMemeberShips[0]?.user;
    if (!admin) {
      console.warn(`  skip org=${org.id} (${org.name}): no SUPER_ADMIN`);
      continue;
    }

    const radiusKm =
      org.charityPickupPrefs?.radiusKm && org.charityPickupPrefs.radiusKm > 0
        ? org.charityPickupPrefs.radiusKm
        : DEFAULT_PICKUP_RADIUS_KM;

    const site = await prisma.site.create({
      data: {
        organisationId: org.id,
        organisationName: org.name,
        address: org.address || 'Head office',
        postcode: org.charityPickupPrefs?.postCode ?? '',
        contactName: `${admin.firstName} ${admin.lastName}`.trim() || admin.email,
        contactEmail: admin.email,
        contactMobile: admin.phoneNumber ?? '',
        latitude: org.latitude ?? undefined,
        longitude: org.longitude ?? undefined,
        pickupRadiusKm: radiusKm,
      },
    });

    await prisma.siteAccess.upsert({
      where: { userId_siteId: { userId: admin.id, siteId: site.id } },
      create: {
        userId: admin.id,
        siteId: site.id,
        organisationId: org.id,
        siteRole: SiteRole.SITE_ADMIN,
        grantedBy: admin.id,
      },
      update: {
        siteRole: SiteRole.SITE_ADMIN,
        grantedBy: admin.id,
      },
    });

    if (org.latitude != null && org.longitude != null) {
      await syncSiteLocation(site.id, org.latitude, org.longitude);
    }

    created += 1;
    console.log(
      `  org=${org.id} "${org.name}" → site=${site.id} admin=${admin.email}` +
        (org.latitude != null && org.longitude != null
          ? ` coords=(${org.latitude},${org.longitude})`
          : ' (no coords on org)'),
    );
  }

  if (!candidates) {
    console.log('No CHARITY_MULTI orgs without sites. Nothing to do.');
    return;
  }

  console.log(
    `\nDone. Created ${created}/${candidates} HQ site(s). Affected users must log in again so JWT includes siteId.`,
  );
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
