// Must precede any TLS use — mirrors src/main.ts, the Aiven cert is self-signed.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
import 'dotenv/config';
import {
  OrgRole,
  OrgType,
  PlatformRole,
  PrismaClient,
  Region,
  SiteRole,
} from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import * as bcrypt from 'bcrypt';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Local development fixtures for exercising the billing flow.
 *
 * Creates a platform admin (needed for the Stripe catalogue sync) plus one
 * billable org per region so AUD and INR checkouts can both be tested.
 * Idempotent — re-running updates the existing users rather than duplicating.
 *
 *   npx ts-node --compiler-options '{"module":"CommonJS"}' prisma/dev-fixtures.ts
 */

const PASSWORD = 'Test1234!';

const caPath = path.join(process.cwd(), 'src/infra/prisma', 'ca.pem');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: fs.existsSync(caPath)
    ? { rejectUnauthorized: false, ca: fs.readFileSync(caPath).toString() }
    : undefined,
});
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

async function upsertUser(email: string, platformRole: PlatformRole) {
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
      emailVerified: true,
      isActive: true,
    },
    update: { passwordHash, platformRole, emailVerified: true, isActive: true },
  });
}

async function createOrg(email: string, orgType: OrgType, region: Region, name: string) {
  const existing = await prisma.user.findUnique({
    where: { email },
    include: { orgMemeberShips: true },
  });
  if (existing?.orgMemeberShips.length) {
    console.log(`  ${name.padEnd(16)} already exists (org=${existing.orgMemeberShips[0].organisationId})`);
    return;
  }

  const user = await upsertUser(email, PlatformRole.ORG_USER);
  const org = await prisma.organisation.create({
    data: { name, organizationType: orgType, address: '1 Test Street', region },
  });
  await prisma.orgMemeberShip.create({
    data: { userId: user.id, organisationId: org.id, orgRole: OrgRole.SUPER_ADMIN },
  });
  const site = await prisma.site.create({
    data: {
      organisationId: org.id,
      organisationName: name,
      address: '1 Test Street',
      contactName: 'Dev User',
      contactEmail: email,
      contactMobile: '0400000000',
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

  console.log(`  ${name.padEnd(16)} org=${org.id} site=${site.id} region=${region} (${orgType})`);
}

async function main() {
  const admin = await upsertUser('admin@dev.local', PlatformRole.PLATFORM_ADMIN);
  console.log(`  platform admin   userId=${admin.id} admin@dev.local`);

  await createOrg('au@dev.local', OrgType.BUSINESS_SINGLE, Region.AU, 'AU Test Cafe');
  await createOrg('in@dev.local', OrgType.BUSINESS_SINGLE, Region.IN, 'IN Test Cafe');
  await createOrg('multi@dev.local', OrgType.BUSINESS_MULTI, Region.AU, 'AU Multi Cafe');

  console.log(`\n  All accounts use password: ${PASSWORD}`);
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
