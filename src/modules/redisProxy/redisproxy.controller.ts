import { Logger, Injectable, Body, Post, Get, Controller } from '@nestjs/common';
import { RedisProxyService } from './redis.proxy,service';

interface DriverDTO {
  driverId: string;
  driverName: string;
  driverPhone: string;
  long: number;
  latitude: number;
}

interface GetNearByDriversRequestDto {
  long: number;
  latitude: number;
  radius: number;
}


@Controller('search/driver')
export class RedisProxyController {
  private readonly logger = new Logger(RedisProxyController.name);
  constructor(private readonly redisProxyService: RedisProxyService) {}

  @Post('add-driver')
  async addDriver(@Body() driver: DriverDTO) {
    await this.redisProxyService.addDriver(
      driver.driverId,
      driver.driverName,
      driver.driverPhone,
      driver.long,
      driver.latitude,
    );
  }

  @Get('/nearby-driver')
  async getNearbyDrivers(@Body() dto: GetNearByDriversRequestDto) {
    return this.redisProxyService.findNearByDriversWirhReduous(
      dto.long,
      dto.latitude,
      dto.radius,
    );
  }
}
