import {
  Controller,
  Get,
  Query,
  ParseFloatPipe,
  DefaultValuePipe,
  ParseIntPipe,
  UseGuards,
} from '@nestjs/common';
import { Region } from '@prisma/client';
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard';
import { RedisGeoSearchService } from './redis.geosearch.service';


@Controller('geo')
export class RedisGeoSearchController {
  constructor(private readonly geoSearch: RedisGeoSearchService) {}

  // GET /geo/nearby-charities?lat=12.97&lng=77.59&radiusKm=10&region=IN
  @Get('nearby-charities')
  async getNearbyCharities(
    @Query('lat', ParseFloatPipe) lat: number,
    @Query('lng', ParseFloatPipe) lng: number,
    @Query('radiusKm', new DefaultValuePipe(10), ParseIntPipe) radiusKm: number,
    @Query('region', new DefaultValuePipe(Region.IN)) region: Region,
  ) {
    return this.geoSearch.searchNearbyCharities(lat, lng, radiusKm, region);
  }
}
