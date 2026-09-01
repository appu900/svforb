// Must precede any TLS use — mirrors src/main.ts, the Aiven cert is self-signed.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
import 'dotenv/config';
import { OrgType, PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { createPgPool } from '../src/infra/prisma/create-pg-pool';

/**
 * Seeds the subscription catalogue.
 *
 * Idempotent — re-running upserts plans by `name` and replaces each plan's
 * compare-grid rows, so `prisma migrate reset` and repeated runs both land
 * on the same catalogue.
 */

const pool = createPgPool();
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

const BUSINESS_SINGLE_PLANS: OrgType[] = [
  OrgType.BUSINESS_SINGLE,
  OrgType.FARMER_PRODUCER,
];
const BUSINESS_MULTI_PLANS: OrgType[] = [OrgType.BUSINESS_MULTI];

const CAT_USERS = 'USERS';
const CAT_OPS = 'OPERATIONS & REPORTING';

// ⚠️  PLACEHOLDER INR PRICING — FOR TESTING ONLY, NOT FOR LAUNCH.
// Deliberately tiny so real Stripe checkouts in INR cost next to nothing.
// Replace with real India pricing before going live.
const INR_IS_TEST_PRICING = true;

/** Compare-grid rows. Only the two single-site plans appear in the design's toggle. */
function compareGrid(usersValue: string, plus: boolean) {
  return [
    { key: 'users_included', category: CAT_USERS, label: 'Users included', included: true, value: usersValue },
    { key: 'surplus_listing', category: CAT_OPS, label: 'Surplus Listing', included: true },
    { key: 'charity_matching', category: CAT_OPS, label: 'Charity matching & pickup coordination', included: true },
    { key: 'basic_impact_tracking', category: CAT_OPS, label: 'Basic impact tracking', included: true },
    { key: 'date_specification', category: CAT_OPS, label: 'Date specification', included: true },
    { key: 'operational_insights', category: CAT_OPS, label: 'Operational insights', included: plus },
    { key: 'cost_saving_insights', category: CAT_OPS, label: 'Identify cost saving opportunities', included: plus },
    { key: 'esg_reports', category: CAT_OPS, label: 'Download ESG & management report', included: plus },
    { key: 'priority_support', category: CAT_OPS, label: 'Priority support', included: plus },
  ];
}

const PLANS = [
  {
    name: 'SINGLE_SITE',
    displayName: 'Single Site',
    description:
      'For businesses getting started with surplus tracking and impact reporting.',
    maxSites: 1,
    maxUserPerSite: 2,
    priceMonthly: 49,
    priceAnnual: 490,
    priceMonthlyInr: 5, // TEST pricing
    priceAnnualInr: 50, // TEST pricing
    isPerSite: false,
    contactSalesOnly: false,
    applicableOrgTypes: BUSINESS_SINGLE_PLANS,
    features: [
      '1 site',
      'Up to 2 users',
      'Quick surplus listing',
      'Charity matching & pick up coordination',
      'Basic impact tracking & date specification',
      'Email support',
    ],
    inheritsFrom: null,
    isMostPopular: false,
    sortOrder: 1,
    grid: compareGrid('Up to 2', false),
  },
  {
    name: 'SINGLE_SITE_PLUS',
    displayName: 'Single Site +',
    description:
      'For businesses ready to optimise operations with advanced insights, reporting & ESG measurement.',
    maxSites: 1,
    maxUserPerSite: 6,
    priceMonthly: 69,
    priceAnnual: 690,
    priceMonthlyInr: 7, // TEST pricing
    priceAnnualInr: 70, // TEST pricing
    isPerSite: false,
    contactSalesOnly: false,
    applicableOrgTypes: BUSINESS_SINGLE_PLANS,
    features: [
      'Up to 6 users',
      'Advanced reporting dashboard',
      'Identify cost-saving opportunities & reduce unnecessary spend',
      'Download ESG & management reports',
      'Priority support',
    ],
    inheritsFrom: 'SINGLE_SITE',
    isMostPopular: true,
    sortOrder: 2,
    grid: compareGrid('Up to 6', true),
  },
  {
    name: 'MULTI_SITE',
    displayName: 'Multi Site',
    description:
      'For businesses managing multiple locations with consistent reporting and operations.',
    maxSites: 10,
    maxUserPerSite: null,
    priceMonthly: 89, // flat fee covering up to 10 locations
    priceAnnual: 890, // flat fee covering up to 10 locations
    priceMonthlyInr: 9, // TEST pricing, flat fee
    priceAnnualInr: 90, // TEST pricing, flat fee
    isPerSite: false,
    contactSalesOnly: false,
    applicableOrgTypes: BUSINESS_MULTI_PLANS,
    features: [
      'Manage up to 10 locations',
      'Manage all locations from one dashboard',
      'Compare performance across locations',
      'Consistent process across every site',
      'Dedicated onboarding support',
    ],
    inheritsFrom: null,
    isMostPopular: false,
    sortOrder: 3,
    grid: [],
  },
  {
    name: 'ENTERPRISE',
    displayName: 'Enterprise',
    description:
      'For organisations requiring enterprise-scale deployment and support.',
    maxSites: null, // unlimited
    maxUserPerSite: null, // unlimited
    priceMonthly: null, // custom pricing
    priceAnnual: null,
    priceMonthlyInr: null,
    priceAnnualInr: null,
    isPerSite: false,
    contactSalesOnly: true,
    applicableOrgTypes: BUSINESS_MULTI_PLANS,
    features: [
      'Unlimited locations',
      'Enterprise analytics & executive dashboards',
      'Custom implementation & onboarding',
      'Dedicated Customer Success Manager',
      'Priority support & SLA',
    ],
    inheritsFrom: 'MULTI_SITE',
    isMostPopular: false,
    sortOrder: 4,
    grid: [],
  },
] as const;

async function main() {
  if (INR_IS_TEST_PRICING) {
    console.warn(
      '  ⚠️  INR prices are PLACEHOLDER TEST VALUES (₹5–₹9/mo). Replace before launch.',
    );
  }

  const idByName = new Map<string, number>();

  // First pass: upsert plans without the self-relation, so parents exist.
  for (const p of PLANS) {
    const data = {
      displayName: p.displayName,
      description: p.description,
      maxSites: p.maxSites,
      maxUserPerSite: p.maxUserPerSite,
      priceMonthly: p.priceMonthly,
      priceAnnual: p.priceAnnual,
      priceMonthlyInr: p.priceMonthlyInr,
      priceAnnualInr: p.priceAnnualInr,
      currency: 'AUD',
      isPerSite: p.isPerSite,
      contactSalesOnly: p.contactSalesOnly,
      applicableOrgTypes: [...p.applicableOrgTypes],
      features: [...p.features],
      isMostPopular: p.isMostPopular,
      sortOrder: p.sortOrder,
      isActive: true,
    };

    const plan = await prisma.subscriptionPlan.upsert({
      where: { name: p.name },
      create: { name: p.name, ...data },
      update: data,
    });
    idByName.set(p.name, plan.id);
    console.log(`  plan  ${p.name.padEnd(18)} -> id=${plan.id}`);
  }

  // Second pass: wire "includes everything in X, plus:".
  for (const p of PLANS) {
    if (!p.inheritsFrom) continue;
    await prisma.subscriptionPlan.update({
      where: { name: p.name },
      data: { inheritsFromId: idByName.get(p.inheritsFrom)! },
    });
  }

  // Compare grid — replace wholesale so removed rows don't linger.
  for (const p of PLANS) {
    const planId = idByName.get(p.name)!;
    await prisma.planFeature.deleteMany({ where: { planId } });
    if (!p.grid.length) continue;

    await prisma.planFeature.createMany({
      data: p.grid.map((f, i) => ({
        planId,
        key: f.key,
        category: f.category,
        label: f.label,
        included: f.included,
        value: 'value' in f ? (f.value as string) : null,
        sortOrder: i + 1,
      })),
    });
    console.log(`  grid  ${p.name.padEnd(18)} -> ${p.grid.length} rows`);
  }

  // This catalogue is the source of truth. Any other plan is legacy: drop it if
  // nothing points at it, otherwise just deactivate so existing rows stay valid.
  const catalogue = PLANS.map((p) => p.name);
  const legacyPlans = await prisma.subscriptionPlan.findMany({
    where: { name: { notIn: catalogue } },
    select: { id: true, name: true, _count: { select: { orgSubscriptions: true } } },
  });

  for (const lp of legacyPlans) {
    if (lp._count.orgSubscriptions > 0) {
      await prisma.subscriptionPlan.update({
        where: { id: lp.id },
        data: { isActive: false },
      });
      console.log(
        `  legacy ${lp.name} deactivated (${lp._count.orgSubscriptions} org(s) reference it)`,
      );
    } else {
      await prisma.subscriptionPlan.delete({ where: { id: lp.id } });
      console.log(`  legacy ${lp.name} removed (unreferenced)`);
    }
  }
}

main()
  .then(() => console.log('Seed complete.'))
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
