import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
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

    const plan = await this.prisma.subscriptionPlan.create({ data: dto });
    this.logger.log(`Subscription plan created: ${plan.name}`);
    return plan;
  }

  async findAll() {
    return this.prisma.subscriptionPlan.findMany({
      orderBy: { createdAt: 'asc' },
    });
  }

  async findOne(id: number) {
    const plan = await this.prisma.subscriptionPlan.findUnique({
      where: { id },
    });
    if (!plan) throw new NotFoundException('Subscription plan not found');
    return plan;
  }

  async update(id: number, dto: UpdateSubscriptionPlanDto) {
    await this.findOne(id);
    const plan = await this.prisma.subscriptionPlan.update({
      where: { id },
      data: dto,
    });
    this.logger.log(`Subscription plan updated: ${plan.name}`);
    return plan;
  }

  async remove(id: number) {
    await this.findOne(id);
    await this.prisma.subscriptionPlan.delete({ where: { id } });
    this.logger.log(`Subscription plan deleted: id=${id}`);
    return { message: 'Subscription plan deleted' };
  }
}
