import {
  Body,
  Controller,
  Delete,
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
import { ClaimStatus } from '@prisma/client';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { Jwtpayload } from '../../auth/interface/jwt.interface';
import { ClaimsService } from '../services/claims.service';
import { CreateClaimDto, MarkCollectedDto, RateClaimDto } from '../dto/claims.dto';

@Controller('claims')
@UseGuards(JwtAuthGuard)
export class ClaimsController {
  constructor(private readonly service: ClaimsService) {}

  @Post()
  claim(
    @Req() req: Request & { user: Jwtpayload },
    @Body() dto: CreateClaimDto,
  ) {
    return this.service.claimListing(req.user, dto);
  }

  @Get('my')
  getMyClaims(
    @Req() req: Request & { user: Jwtpayload },
    @Query('page', new ParseIntPipe({ optional: true })) page = 1,
    @Query('limit', new ParseIntPipe({ optional: true })) limit = 20,
    @Query('status') status?: ClaimStatus,
  ) {
    return this.service.getMyClaims(req.user, page, limit, status);
  }

  @Get('listing/:listingId')
  getListingClaims(
    @Req() req: Request & { user: Jwtpayload },
    @Param('listingId', ParseIntPipe) listingId: number,
  ) {
    return this.service.getListingClaims(req.user, listingId);
  }

  @Get('listing/:listingId/activity')
  getClaimActivity(
    @Req() req: Request & { user: Jwtpayload },
    @Param('listingId', ParseIntPipe) listingId: number,
  ) {
    return this.service.getClaimActivity(req.user, listingId);
  }

  @Post(':id/request-driver')
  requestDriver(
    @Req() req: Request & { user: Jwtpayload },
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.service.requestDriverPickup(req.user, id);
  }

  @Patch(':id/confirm')
  confirm(
    @Req() req: Request & { user: Jwtpayload },
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.service.confirmClaim(req.user, id);
  }

  @Patch(':id/collected')
  markCollected(
    @Req() req: Request & { user: Jwtpayload },
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: MarkCollectedDto,
  ) {
    return this.service.markCollected(req.user, id, dto);
  }

  /** Submit / update feedback for a collected claim. */
  @Patch(':id/rating')
  rateClaim(
    @Req() req: Request & { user: Jwtpayload },
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: RateClaimDto,
  ) {
    return this.service.rateClaim(req.user, id, dto);
  }

  @Delete(':id')
  cancel(
    @Req() req: Request & { user: Jwtpayload },
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.service.cancelClaim(req.user, id);
  }
}
