import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard';
import { Jwtpayload } from '../auth/interface/jwt.interface';
import { CreateListingDto } from './dto/food.listing.dto';
import { FoodListingService } from './foodlisting.service';

@Controller('listings')
@UseGuards(JwtAuthGuard)
export class FoodListingController {
  constructor(private readonly foodListingService: FoodListingService) {}

  @Post()
  createListing(
    @Req() req: Request & { user: Jwtpayload },
    @Body() dto: CreateListingDto,
  ) {
    return this.foodListingService.createListing(req.user.orgId!, dto);
  }
}
