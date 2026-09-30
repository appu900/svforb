import { Logger, OnModuleInit, Injectable } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { createPgPool } from './create-pg-pool';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit {
  private readonly logger = new Logger(PrismaService.name);
  constructor() {
    // Idle connections get dropped silently somewhere between here and the
    // database. A query sent on one of those never gets an answer, so the
    // request hangs for minutes. Keepalives detect dead sockets, no pinned
    // `min` connections sit idle long enough to be dropped, and the timeouts
    // turn anything that still gets stuck into a fast error instead of a hang.
    const pool = createPgPool({
      max: 20,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      keepAlive: true,
      keepAliveInitialDelayMillis: 10_000,
      statement_timeout: 30_000,
      query_timeout: 35_000,
    });
    super({ adapter: new PrismaPg(pool) });
  }

  async onModuleInit() {
    await this.$connect();
    this.logger.debug('DATABASE CONNECTED');
  }
}
