import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard';
import { Jwtpayload } from '../auth/interface/jwt.interface';
import {
  CreateListingDto,
  GetListingsQueryDto,
  RelistDto,
  UpdateListingDto,
} from './dto/food.listing.dto';
import { FoodListingService } from './foodlisting.service';

@Controller('listings')
@UseGuards(JwtAuthGuard)
export class FoodListingController {
  constructor(private readonly foodListingService: FoodListingService) {}

  // POST /listings
  @Post()
  createListing(
    @Req() req: Request & { user: Jwtpayload },
    @Body() dto: CreateListingDto,
  ) {
    return this.foodListingService.createListing(req.user.orgId!, dto);
  }

  // GET /listings?status=ACTIVE&page=1&limit=20
  @Get()
  getListings(
    @Req() req: Request & { user: Jwtpayload },
    @Query() query: GetListingsQueryDto,
  ) {
    return this.foodListingService.getListings(req.user.orgId!, query);
  }

  // GET /listings/:id
  @Get(':id')
  getListing(
    @Req() req: Request & { user: Jwtpayload },
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.foodListingService.getListing(req.user.orgId!, id);
  }

  // POST /listings/:id/relist
  @Post(':id/relist')
  relistListing(
    @Req() req: Request & { user: Jwtpayload },
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: RelistDto,
  ) {
    return this.foodListingService.relistListing(req.user.orgId!, id, dto);
  }

  // PATCH /listings/:id
  @Patch(':id')
  updateListing(
    @Req() req: Request & { user: Jwtpayload },
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateListingDto,
  ) {
    return this.foodListingService.updateListing(req.user.orgId!, id, dto);
  }

  // PATCH /listings/:id/cancel
  @Patch(':id/cancel')
  cancelListing(
    @Req() req: Request & { user: Jwtpayload },
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.foodListingService.cancelListing(req.user.orgId!, id);
  }
}
