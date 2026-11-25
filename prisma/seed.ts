// Must precede any TLS use — mirrors src/main.ts, the Aiven cert is self-signed.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
import 'dotenv/config';
import { BillingModule, OrgType, PlanScope, PrismaClient } from '@prisma/client';
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
/** Make Food Count is sold to restaurants only — farms buy Saveful Connect. */
const RESTAURANT_SINGLE_PLANS: OrgType[] = [OrgType.BUSINESS_SINGLE];
const BUSINESS_MULTI_PLANS: OrgType[] = [OrgType.BUSINESS_MULTI];

const CAT_USERS = 'USERS';
const CAT_MODULES = 'MODULES';
const CAT_OPS = 'OPERATIONS & REPORTING';

const TRIAL_DAYS = 30;

// ⚠️  PLACEHOLDER INR PRICING — FOR TESTING ONLY, NOT FOR LAUNCH.
// Deliberately tiny so real Stripe checkouts in INR cost next to nothing.
// Replace with real India pricing before going live.
const INR_IS_TEST_PRICING = true;

type GridRow = {
  key: string;
  category: string;
  label: string;
  included: boolean;
  value?: string;
};

/** Compare-grid rows of the legacy Single Site tiers. Kept for their subscribers. */
function legacyGrid(usersValue: string, plus: boolean): GridRow[] {
  return [
    { key: 'users_included', category: CAT_USERS, label: 'Users included', included: true, value: usersValue },
    { key: 'module_connect', category: CAT_MODULES, label: 'Saveful Connect', included: true },
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

/**
 * Entitlement keys of a module plan. `module_*` keys are what the API gates on.
 * Connect plans also carry the reporting keys that app builds released before
 * modular billing use to unlock advanced impact.
 */
function moduleGrid(mfc: boolean, connect: boolean): GridRow[] {
  return [
    { key: 'users_included', category: CAT_USERS, label: 'Users included', included: true, value: 'Unlimited' },
    { key: 'module_mfc', category: CAT_MODULES, label: 'Make Food Count', included: mfc },
    { key: 'module_connect', category: CAT_MODULES, label: 'Saveful Connect', included: connect },
    { key: 'surplus_listing', category: CAT_OPS, label: 'Surplus Listing', included: connect },
    { key: 'charity_matching', category: CAT_OPS, label: 'Charity matching & pickup coordination', included: connect },
    { key: 'basic_impact_tracking', category: CAT_OPS, label: 'Impact tracking', included: true },
    { key: 'operational_insights', category: CAT_OPS, label: 'Operational insights', included: true },
    { key: 'cost_saving_insights', category: CAT_OPS, label: 'Identify cost saving opportunities', included: connect },
    { key: 'esg_reports', category: CAT_OPS, label: 'Downloadable reports', included: connect },
  ];
}

// ─── Card copy (from the "Your Plan" design) ─────────────────────────────────

const MFC_COPY = {
  displayName: 'Make Food Count',
  tagline: 'Understand your food. Discover more savings.',
  description:
    'Easily record food loss across your kitchen operations, identify opportunities to improve and track your food savings over time.',
  closingLine: 'Turn everyday food insights into smarter decisions and greater savings.',
  features: [
    'Simple food-loss tracking — no special equipment required',
    'Record overproduction, spoilage, preparation and plate scraps',
    'Track food types, quantities and sources',
    'See what happened to your food',
    'Identify trends and opportunities to save',
    'Track improvements over time',
    'Detailed dashboards & downloadable reports',
  ],
  multiFeatures: [
    'Centralised site management',
    'Individual and consolidated reporting',
    'Compare food-loss performance across sites',
    'Identify savings opportunities across locations',
  ],
};

const CONNECT_COPY = {
  displayName: 'Saveful Connect',
  tagline: 'Make more of your surplus food.',
  description:
    'Connect with local charities and recovery partners, coordinate collections and see the difference your surplus food makes.',
  closingLine: "Make more of your surplus food and see the difference you're making.",
  features: [
    'List and manage surplus food',
    'Connect with charities and recovery partners',
    'Collection notifications and tracking',
    'Digital collection and handover records',
    'Reporting on food redistributed & destinations',
    'Track meals created and CO₂e avoided',
    'Downloadable reports and insights',
  ],
  multiFeatures: [
    'Centralised site management',
    'Individual and consolidated reporting',
    'Consolidated collections',
    'Collection and recipient visibility across sites',
  ],
};

const COMPLETE_COPY = {
  displayName: 'Complete Solution',
  tagline: 'One simple system. More savings. Greater impact.',
  description:
    "Bring food tracking and redistribution together in one connected system. Understand what's happening in your kitchen, redirect surplus food and measure the difference you're making.",
  closingLine: 'Know more about your food, save more and make every kilogram count.',
  /** Shown under "Everything in both modules, plus:" */
  features: [
    'Record food and create redistribution listings in one connected process',
    'Track food from initial recording through to collection',
    'See what was recorded, redirected and where it went',
    'Combined insights across food savings & redistribution',
    'One platform for your team, with no unnecessary duplication',
    'Discounted pricing when you choose both modules',
  ],
  multiFeatures: [
    'Centralised site management',
    'Individual and consolidated reporting',
    'Consolidated collections across sites',
    'Compare food-loss performance and savings across locations',
  ],
};

const SINGLE_SITE_LINES = ['1 site', 'Unlimited users'];
const MULTI_SITE_LINES = ['Up to 10 sites', 'Unlimited users'];

type PlanSeed = {
  name: string;
  displayName: string;
  description: string;
  module: BillingModule;
  scope: PlanScope;
  trialDays: number;
  tagline: string | null;
  closingLine: string | null;
  badge: string | null;
  maxSites: number | null;
  maxUserPerSite: number | null;
  priceMonthly: number | null;
  priceAnnual: number | null;
  priceMonthlyInr: number | null;
  priceAnnualInr: number | null;
  isPerSite: boolean;
  contactSalesOnly: boolean;
  applicableOrgTypes: OrgType[];
  features: string[];
  inheritsFrom: string | null;
  isMostPopular: boolean;
  sortOrder: number;
  /** false = kept for existing subscribers, never offered for sale */
  isActive: boolean;
  grid: GridRow[];
};

const PLANS: PlanSeed[] = [
  // ─── Single site ───────────────────────────────────────────────────────────
  {
    name: 'MFC_SINGLE',
    ...MFC_COPY,
    module: BillingModule.MFC,
    scope: PlanScope.SINGLE,
    trialDays: 0,
    badge: null,
    maxSites: 1,
    maxUserPerSite: null,
    priceMonthly: 49,
    priceAnnual: 490,
    priceMonthlyInr: 5, // TEST pricing
    priceAnnualInr: 50, // TEST pricing
    isPerSite: false,
    contactSalesOnly: false,
    applicableOrgTypes: RESTAURANT_SINGLE_PLANS,
    features: [...SINGLE_SITE_LINES, ...MFC_COPY.features],
    inheritsFrom: null,
    isMostPopular: false,
    sortOrder: 1,
    isActive: true,
    grid: moduleGrid(true, false),
  },
  {
    name: 'CONNECT_SINGLE',
    ...CONNECT_COPY,
    module: BillingModule.CONNECT,
    scope: PlanScope.SINGLE,
    trialDays: TRIAL_DAYS,
    badge: null,
    maxSites: 1,
    maxUserPerSite: null,
    priceMonthly: 49,
    priceAnnual: 490,
    priceMonthlyInr: 5, // TEST pricing
    priceAnnualInr: 50, // TEST pricing
    isPerSite: false,
    contactSalesOnly: false,
    applicableOrgTypes: BUSINESS_SINGLE_PLANS,
    features: [...SINGLE_SITE_LINES, ...CONNECT_COPY.features],
    inheritsFrom: null,
    isMostPopular: false,
    sortOrder: 2,
    isActive: true,
    grid: moduleGrid(false, true),
  },
  {
    name: 'COMPLETE_SINGLE',
    ...COMPLETE_COPY,
    module: BillingModule.COMPLETE,
    scope: PlanScope.SINGLE,
    trialDays: TRIAL_DAYS,
    badge: 'Best value',
    maxSites: 1,
    maxUserPerSite: null,
    priceMonthly: 89,
    priceAnnual: 890,
    priceMonthlyInr: 9, // TEST pricing
    priceAnnualInr: 90, // TEST pricing
    isPerSite: false,
    contactSalesOnly: false,
    applicableOrgTypes: RESTAURANT_SINGLE_PLANS,
    features: [...COMPLETE_COPY.features],
    inheritsFrom: null,
    isMostPopular: true,
    sortOrder: 3,
    isActive: true,
    grid: moduleGrid(true, true),
  },

  // ─── Multi site (billed per site) ─────────────────────────────────────────
  {
    name: 'MFC_MULTI',
    ...MFC_COPY,
    module: BillingModule.MFC,
    scope: PlanScope.MULTI,
    trialDays: 0,
    badge: null,
    maxSites: 10,
    maxUserPerSite: null,
    priceMonthly: 69,
    priceAnnual: 690,
    priceMonthlyInr: 7, // TEST pricing
    priceAnnualInr: 70, // TEST pricing
    isPerSite: true,
    contactSalesOnly: false,
    applicableOrgTypes: BUSINESS_MULTI_PLANS,
    features: [...MULTI_SITE_LINES, ...MFC_COPY.multiFeatures, ...MFC_COPY.features],
    inheritsFrom: null,
    isMostPopular: false,
    sortOrder: 4,
    isActive: true,
    grid: moduleGrid(true, false),
  },
  {
    name: 'CONNECT_MULTI',
    ...CONNECT_COPY,
    module: BillingModule.CONNECT,
    scope: PlanScope.MULTI,
    trialDays: TRIAL_DAYS,
    badge: null,
    maxSites: 10,
    maxUserPerSite: null,
    priceMonthly: 69,
    priceAnnual: 690,
    priceMonthlyInr: 7, // TEST pricing
    priceAnnualInr: 70, // TEST pricing
    isPerSite: true,
    contactSalesOnly: false,
    applicableOrgTypes: BUSINESS_MULTI_PLANS,
    features: [...MULTI_SITE_LINES, ...CONNECT_COPY.multiFeatures, ...CONNECT_COPY.features],
    inheritsFrom: null,
    isMostPopular: false,
    sortOrder: 5,
    isActive: true,
    grid: moduleGrid(false, true),
  },
  {
    name: 'COMPLETE_MULTI',
    ...COMPLETE_COPY,
    module: BillingModule.COMPLETE,
    scope: PlanScope.MULTI,
    trialDays: TRIAL_DAYS,
    badge: 'Best value',
    maxSites: 10,
    maxUserPerSite: null,
    priceMonthly: 99,
    priceAnnual: 990,
    priceMonthlyInr: 10, // TEST pricing
    priceAnnualInr: 100, // TEST pricing
    isPerSite: true,
    contactSalesOnly: false,
    applicableOrgTypes: BUSINESS_MULTI_PLANS,
    features: [...MULTI_SITE_LINES, ...COMPLETE_COPY.multiFeatures, ...COMPLETE_COPY.features],
    inheritsFrom: null,
    isMostPopular: true,
    sortOrder: 6,
    isActive: true,
    grid: moduleGrid(true, true),
  },
  {
    name: 'ENTERPRISE',
    displayName: 'Enterprise',
    description:
      'For organisations requiring enterprise-scale deployment and support.',
    module: BillingModule.COMPLETE,
    scope: PlanScope.ENTERPRISE,
    trialDays: 0,
    tagline: '10+ locations',
    closingLine: null,
    badge: null,
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
      'Make Food Count and Saveful Connect included',
      'Enterprise analytics & executive dashboards',
      'Custom implementation & onboarding',
      'Dedicated Customer Success Manager',
      'Priority support & SLA',
    ],
    inheritsFrom: 'COMPLETE_MULTI',
    isMostPopular: false,
    sortOrder: 7,
    isActive: true,
    grid: moduleGrid(true, true),
  },

  // ─── Legacy tiers: hidden from sale, kept for existing subscribers ────────
  // They sold Saveful Connect, so they grant that module at their original price.
  {
    name: 'SINGLE_SITE',
    displayName: 'Single Site',
    description:
      'For businesses getting started with surplus tracking and impact reporting.',
    module: BillingModule.CONNECT,
    scope: PlanScope.SINGLE,
    trialDays: TRIAL_DAYS,
    tagline: null,
    closingLine: null,
    badge: null,
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
    sortOrder: 21,
    isActive: false,
    grid: legacyGrid('Up to 2', false),
  },
  {
    name: 'SINGLE_SITE_PLUS',
    displayName: 'Single Site +',
    description:
      'For businesses ready to optimise operations with advanced insights, reporting & ESG measurement.',
    module: BillingModule.CONNECT,
    scope: PlanScope.SINGLE,
    trialDays: TRIAL_DAYS,
    tagline: null,
    closingLine: null,
    badge: null,
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
    isMostPopular: false,
    sortOrder: 22,
    isActive: false,
    grid: legacyGrid('Up to 6', true),
  },
  {
    name: 'MULTI_SITE',
    displayName: 'Multi Site',
    description:
      'For businesses managing multiple locations with consistent reporting and operations.',
    module: BillingModule.CONNECT,
    scope: PlanScope.MULTI,
    trialDays: TRIAL_DAYS,
    tagline: null,
    closingLine: null,
    badge: null,
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
    sortOrder: 23,
    isActive: false,
    // Before modular billing this tier carried no grid; the module key is what grants Connect.
    grid: legacyGrid('Unlimited', true),
  },
];

async function main() {
  if (INR_IS_TEST_PRICING) {
    console.warn(
      '  ⚠️  INR prices are PLACEHOLDER TEST VALUES (₹5–₹10/mo). Replace before launch.',
    );
  }

  const idByName = new Map<string, number>();

  // First pass: upsert plans without the self-relation, so parents exist.
  for (const p of PLANS) {
    const data = {
      displayName: p.displayName,
      description: p.description,
      module: p.module,
      scope: p.scope,
      trialDays: p.trialDays,
      tagline: p.tagline,
      closingLine: p.closingLine,
      badge: p.badge,
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
      isActive: p.isActive,
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
    await prisma.subscriptionPlan.update({
      where: { name: p.name },
      data: { inheritsFromId: p.inheritsFrom ? idByName.get(p.inheritsFrom)! : null },
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
        value: f.value ?? null,
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
