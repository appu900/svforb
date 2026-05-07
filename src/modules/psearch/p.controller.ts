import {
  Controller,
  Get,
  Query,
  ParseFloatPipe,
  UseGuards,
  BadRequestException,
  Req,
  DefaultValuePipe,
} from '@nestjs/common';

import { Jwtpayload } from '../auth/interface/jwt.interface';
import { ProximityService } from './psearch.service';
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard';
import { Region } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';

@Controller('proximity')
export class ProximityController {
  constructor(private readonly proximityService: ProximityService,private readonly prisma:PrismaService) {}

  @Get('charities')
  async getNearbyCharities(
    @Query('lat', ParseFloatPipe) lat: number,
    @Query('lng', ParseFloatPipe) lng: number,
    @Query('region', new DefaultValuePipe(Region.IN)) region: Region,
    @Req() req: Request,
  ) {
    return this.proximityService.getNearbyCharities(lat, lng, region);
  }

  // GET /proximity/listings?lat=12.9716&lng=77.5946&region=IN
  @Get('listings')
  async getNearbyListings(
    @Query('lat', ParseFloatPipe) lat: number,
    @Query('lng', ParseFloatPipe) lng: number,
    @Query('region', new DefaultValuePipe(Region.IN)) region: Region,
    @Req() req: Request,
  ) {
    return this.proximityService.getNearbyListings(lat, lng, region);
  }

  // Add this temporarily in any controller
  @Get('fix-locations')
  async fixLocations() {
    await this.prisma.$executeRaw`
    UPDATE organisations
    SET location = ST_SetSRID(
      ST_MakePoint(longitude, latitude), 4326
    )::geography
    WHERE
      latitude  IS NOT NULL
      AND longitude IS NOT NULL
      AND location  IS NULL
  `;
    return { message: 'done' };
  }
}
