

import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../../infra/redis/redis.service';

@Injectable()
export class RedisProxyService{
  private readonly logger = new Logger(RedisProxyService.name);
  constructor(private readonly redis:RedisService) {}

  async addDriver(driverId:string,driverName:string,driverPhone:string,long:number,latitude:number){
    const driverData = JSON.stringify({driverId,driverName,driverPhone,long,latitude});
    const redisClient = this.redis.getClient();
    await redisClient.geoadd('drivers',long,latitude,driverId);
    await redisClient.setex(`driver:${driverId}`, 3600, driverData);
    this.logger.log(`Driver ${driverId} added to Redis`);
  }


  async findNearbyDriveres(long:number,lati:number,radius:number){
    const redisClient = this.redis.getClient();
    return redisClient.georadius('drivers', long, lati, radius, 'km');
  }
  async findNearByDriversWirhReduous(long:number,latitude:number,radius:number){
    const redisClient = this.redis.getClient();
    const nearbyDriverIds = await redisClient.georadius('drivers', long, latitude, radius, 'km');
    const nearbyDrivers: any[] = [];
    for(const driverId of nearbyDriverIds){
      const driverData = await redisClient.get(`driver:${driverId}`);
      if(driverData){
        nearbyDrivers.push(JSON.parse(driverData));
      }
    }
    this.logger.log(`Found ${nearbyDrivers.length} nearby drivers`);
    return nearbyDrivers;
  }
}