import {
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Injectable,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import {Pool} from 'pg'
import * as fs from 'fs'
import * as path from 'path';


@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit {
  private readonly logger = new Logger(PrismaService.name);
  constructor() {
      const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: {
        rejectUnauthorized:false,
        ca:fs.readFileSync(path.join(process.cwd(),'src/infra/prisma','ca.pem')).toString()
      },
    });
    const adapter = new PrismaPg(pool);
    super({ adapter });
  }

  async onModuleInit() {
    try {
      await this.$connect();
      this.logger.debug('DATABASE CONNECTED')
    } catch (error) {
      console.error('problem is connecting the database');
    }
  }
}
