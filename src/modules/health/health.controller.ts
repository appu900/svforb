import { Controller, Get } from '@nestjs/common';
import {
  HealthCheck,
  HealthCheckService,
  HealthIndicatorResult,
  HealthIndicatorService,
} from '@nestjs/terminus';
import { tryCatch } from 'bullmq';
import { HealthService } from './HealthService';

@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly deps: HealthService,
  ) {}

  @Get('')
  @HealthCheck()
  getHealth() {
    return this.health.check([
      () => this.deps.database(),
      () => this.deps.cache(),
    ]);
  }
}
