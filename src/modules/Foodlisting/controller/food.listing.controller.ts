import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Req,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { Request } from 'express';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { Jwtpayload } from '../../auth/interface/jwt.interface';
import { CreateFoodListingDto } from '../dto/food.listing.dto';
import { FoodListingService } from '../services/food.listing.service';
import { ListingStatus } from '@prisma/client';
import { get } from 'https';

@Controller('food-listings')
@UseGuards(JwtAuthGuard)
export class FoodListingController {
  constructor(private readonly service: FoodListingService) {}

  @Post()
  @UseInterceptors(FilesInterceptor('photos', 5))
  create(
    @Req() req: Request & { user: Jwtpayload },
    @Body() dto: CreateFoodListingDto,
    @UploadedFiles() photos?: Express.Multer.File[],
  ) {
    return this.service.createListing(req.user, dto, photos);
  }

  @Get('org/:orgId')
  getByOrg(
    @Param('orgId', ParseIntPipe) orgId: number,
    @Query('page', new ParseIntPipe({ optional: true })) page = 1,
    @Query('limit', new ParseIntPipe({ optional: true })) limit = 20,
    @Query('status') status?: ListingStatus,
  ) {
    return this.service.getOrgListings(orgId, page, limit, status);
  }

  @Get('/site')
  async getListingBySiteId(@Req() req: Request & { user: Jwtpayload }) {
    const userId = req.user.sub;
    const siteId = req.user.siteId;
    const response = await this.service.getAllListingOfSiteID(siteId!, userId);
    return {
      message: 'all listing fetched sucessfully',
      response,
    };
  }

  @Get('recent')
  getRecent(
    @Req() req: Request & { user: Jwtpayload },
    @Query('page', new ParseIntPipe({ optional: true })) page = 1,
    @Query('limit', new ParseIntPipe({ optional: true })) limit = 20,
  ) {
    return this.service.getRecentListings(req.user.siteId!, page, limit);
  }

  @Get(':id')
  getOne(@Param('id', ParseIntPipe) id: number) {
    return this.service.getListingById(id);
  }

  @Delete(':id')
  cancel(
    @Req() req: Request & { user: Jwtpayload },
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.service.cancelListing(req.user, id);
  }
}
