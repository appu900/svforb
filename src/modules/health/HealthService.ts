import { Injectable } from '@nestjs/common';
import {
  HealthIndicatorResult,
  HealthIndicatorService,
} from '@nestjs/terminus';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { RedisService } from 'src/infra/redis/redis.service';

@Injectable()
export class HealthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly health: HealthIndicatorService,
  ) {}

  async database(): Promise<HealthIndicatorResult> {
    const indicator = this.health.check('database');
    const startedAt = Date.now();
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return indicator.up({ responseTimeMs: Date.now() - startedAt });
    } catch (error) {
      return indicator.down({
        responseTimeMs: Date.now() - startedAt,
        message: (error as Error).message,
      });
    }
  }
  async cache(): Promise<HealthIndicatorResult> {
    const indicator = await this.health.check('redis');
    const startedAt = Date.now();
    try {
      const pong = await this.redis.ping();
      if (pong != 'PONG') {
        return indicator.down({ messge: `unexpected reply ${pong}` });
      }
      return indicator.up({
        responseTime: Date.now() - startedAt,
      });
    } catch (error) {
      return indicator.down({
        responseTime: Date.now() - startedAt,
        message: (error as Error).message,
      });
    }
  }
}
