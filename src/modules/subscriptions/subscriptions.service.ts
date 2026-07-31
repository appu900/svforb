import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Region } from '@prisma/client';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { Jwtpayload } from '../auth/interface/jwt.interface';
import { isFreeForever } from './subscription.constants';
import {
  CreateSubscriptionPlanDto,
  UpdateSubscriptionPlanDto,
} from './dto/subscription.dto';

@Injectable()
export class SubscriptionsService {
  private readonly logger = new Logger(SubscriptionsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateSubscriptionPlanDto) {
    const existing = await this.prisma.subscriptionPlan.findUnique({
      where: { name: dto.name },
    });
    if (existing) throw new ConflictException('Plan name already exists');

    // Purchasable immediately — checkout sends the price inline, so there is
    // nothing to create in Stripe ahead of time.
    const plan = await this.prisma.subscriptionPlan.create({ data: dto });
    this.logger.log(`Subscription plan created: ${plan.name}`);
    return plan;
  }

  async findAll() {
    return this.prisma.subscriptionPlan.findMany({
      orderBy: { sortOrder: 'asc' },
    });
  }

  /**
   * Plans offered to the caller's organisation type — backs the
   * "we've recommended the best plan for your business" screen.
   */
  async findAvailableForCaller(caller: Jwtpayload) {
    if (isFreeForever(caller.orgType)) {
      return {
        billingRequired: false,
        message: 'Your organisation has free lifetime access. No plan needed.',
        plans: [],
      };
    }

    const [org, plans] = await Promise.all([
      caller.orgId
        ? this.prisma.organisation.findUnique({
            where: { id: caller.orgId },
            select: { region: true },
          })
        : null,
      this.prisma.subscriptionPlan.findMany({
        where: {
          isActive: true,
          ...(caller.orgType ? { applicableOrgTypes: { has: caller.orgType } } : {}),
        },
        orderBy: { sortOrder: 'asc' },
        include: {
          inheritsFrom: { select: { name: true, displayName: true } },
          planFeatures: { orderBy: { sortOrder: 'asc' } },
        },
      }),
    ]);

    // India sees INR pricing; every other region sees the base AUD pricing.
    const isIndia = org?.region === Region.IN;
    const currency = isIndia ? 'INR' : 'AUD';

    return {
      billingRequired: true,
      currency,
      plans: plans.map((p) => ({
        id: p.id,
        name: p.name,
        displayName: p.displayName,
        description: p.description,
        priceMonthly: isIndia ? p.priceMonthlyInr : p.priceMonthly,
        priceAnnual: isIndia ? p.priceAnnualInr : p.priceAnnual,
        currency,
        isPerSite: p.isPerSite,
        contactSalesOnly: p.contactSalesOnly,
        isMostPopular: p.isMostPopular,
        maxSites: p.maxSites,
        maxUserPerSite: p.maxUserPerSite,
        features: p.features,
        inheritsFrom: p.inheritsFrom?.displayName ?? null,
        comparison: p.planFeatures.map((f) => ({
          key: f.key,
          category: f.category,
          label: f.label,
          included: f.included,
          value: f.value,
        })),
      })),
    };
  }

  async findOne(id: number) {
    const plan = await this.prisma.subscriptionPlan.findUnique({
      where: { id },
    });
    if (!plan) throw new NotFoundException('Subscription plan not found');
    return plan;
  }

  async update(id: number, dto: UpdateSubscriptionPlanDto) {
    const before = await this.findOne(id);

    const plan = await this.prisma.subscriptionPlan.update({
      where: { id },
      data: dto,
    });
    this.logger.log(`Subscription plan updated: ${plan.name}`);

    // New checkouts pick the new amount up immediately. Organisations already
    // subscribed keep paying their original amount — Stripe pins a subscription
    // to the price it was created with, so changing a plan never reprices them.
    const amountChanged =
      before.priceMonthly !== plan.priceMonthly ||
      before.priceAnnual !== plan.priceAnnual ||
      before.priceMonthlyInr !== plan.priceMonthlyInr ||
      before.priceAnnualInr !== plan.priceAnnualInr;

    if (amountChanged) {
      const inUse = await this.prisma.orgSubscription.count({
        where: { planId: id, stripeSubscriptionId: { not: null } },
      });
      if (inUse > 0) {
        this.logger.warn(
          `Pricing changed for ${plan.name}; ${inUse} existing subscriber(s) ` +
            'stay on their original amount until migrated in Stripe.',
        );
      }
    }

    return plan;
  }

  async remove(id: number) {
    await this.findOne(id);
    await this.prisma.subscriptionPlan.delete({ where: { id } });
    this.logger.log(`Subscription plan deleted: id=${id}`);
    return { message: 'Subscription plan deleted' };
  }
}
