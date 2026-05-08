import { Logger, Injectable } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { RedisService } from 'src/infra/redis/redis.service';

@Injectable()
export class DriverLocationService {
  private readonly logger = new Logger(DriverLocationService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  /**
   *     *device --> api ---> queue --> worker --> update the latest location
   *
   */
  async enquedriverLocation(driverId: number) {
    
  }
}
