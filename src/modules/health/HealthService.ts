import { Injectable } from '@nestjs/common';
import {
  HealthIndicatorResult,
  HealthIndicatorService,
} from '@nestjs/terminus';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { RedisService } from 'src/infra/redis/redis.service';
import { FirebaseGateway } from 'src/modules/notifications/gateways/firebase.gateway';

@Injectable()
export class HealthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly health: HealthIndicatorService,
    private readonly firebase: FirebaseGateway,
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

  // ** cache of this is mine
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

  /**
   * Whether push delivery can actually work.
   *
   * Reported as degraded rather than down: pushes being misconfigured must not
   * make a load balancer kill an otherwise healthy instance, but it has to be
   * visible somewhere other than a warning that scrolled past at boot. Push
   * delivery was silently broken for weeks because nothing surfaced it.
   */
  async push(): Promise<HealthIndicatorResult> {
    const indicator = this.health.check('push');
    const business = this.firebase.isReady('business');
    const driver = this.firebase.isReady('driver');

    if (business && driver) return indicator.up({ business, driver });

    const missing = [!business && 'business', !driver && 'driver']
      .filter(Boolean)
      .join(', ');
    return indicator.degraded({
      business,
      driver,
      message: `Firebase not configured for: ${missing}. Push notifications will not be delivered.`,
    });
  }
}
