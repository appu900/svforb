import {
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Req,
  Body,
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
import { SiteNotificationService } from '../services/site.notification.service';
import { ListingStatus } from '@prisma/client';
import { ApiBearerAuth } from '@nestjs/swagger';

@Controller('food-listings')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth('bearer')
export class FoodListingController {
  constructor(
    private readonly service: FoodListingService,
    private readonly notificationService: SiteNotificationService,
  ) {}

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
    @Query('fresh') fresh?: string,
  ) {
    return this.service.getOrgListings(orgId, page, limit, status, fresh === "1" || fresh === "true");
  }

  @Get('/site')
  async getListingBySiteId(@Req() req: Request & { user: Jwtpayload }) {
    const response = await this.service.getAllListingOfSiteID(req.user.siteId!, req.user.sub);
    return { message: 'all listing fetched sucessfully', response };
  }

  @Get('recent')
  getRecent(
    @Req() req: Request & { user: Jwtpayload },
    @Query('page', new ParseIntPipe({ optional: true })) page = 1,
    @Query('limit', new ParseIntPipe({ optional: true })) limit = 20,
  ) {
    return this.service.getRecentListings(req.user.siteId!, page, limit);
  }

  /**
   * Available Food feed — pull-based nearby listings.
   * Push after listing remains mandatory; inbox endpoints stay but are unused for discovery.
   */
  @Get('nearby')
  getNearby(
    @Req() req: Request & { user: Jwtpayload },
    @Query('page', new ParseIntPipe({ optional: true })) page = 1,
    @Query('limit', new ParseIntPipe({ optional: true })) limit = 20,
    @Query('radiusKm', new ParseIntPipe({ optional: true })) radiusKm?: number,
  ) {
    return this.service.getNearbyListings(req.user, page, limit, radiusKm);
  }

  // Inbox kept for later — not used for Available Food discovery

  @Get('notifications')
  getNotificationInbox(
    @Req() req: Request & { user: Jwtpayload },
    @Query('page', new ParseIntPipe({ optional: true })) page = 1,
    @Query('limit', new ParseIntPipe({ optional: true })) limit = 20,
  ) {
    return this.notificationService.getInbox(req.user, page, limit);
  }

  @Patch('notifications/read-all')
  markAllRead(@Req() req: Request & { user: Jwtpayload }) {
    return this.notificationService.markAllRead(req.user);
  }

  @Patch('notifications/:id/read')
  markRead(
    @Req() req: Request & { user: Jwtpayload },
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.notificationService.markRead(req.user, id);
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
