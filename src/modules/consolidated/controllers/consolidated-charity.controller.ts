import {
  Body, Controller, Get, Param, ParseIntPipe, Post, Req, UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import { Request } from 'express';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { ConsolidatedEnabledGuard } from '../consolidated-enabled.guard';
import { Jwtpayload } from '../../auth/interface/jwt.interface';
import { SubmitItemCheckDto } from '../dto/item-check.dto';
import { ConsolidatedCompletionService } from '../services/consolidated-completion.service';

type Req = Request & { user: Jwtpayload };

/**
 * The charity's side of a collection.
 *
 * Nothing here exposes which outlets contributed, or the word "consolidated" —
 * the app shows an item check because the listing said `requiresItemCheck`,
 * not because it was told why (SPEC §2.4).
 */
@Controller('consolidated/charity')
@UseGuards(ConsolidatedEnabledGuard, JwtAuthGuard)
@ApiBearerAuth('bearer')
export class ConsolidatedCharityController {
  constructor(private readonly completion: ConsolidatedCompletionService) {}

  /** The items to confirm, the declaration, and any change awaiting review. */
  @Get('claims/:claimId/item-check')
  itemCheck(@Req() req: Req, @Param('claimId', ParseIntPipe) claimId: number) {
    return this.completion.itemCheck(req.user, claimId);
  }

  /** Records what was accepted, rejected and unavailable, item by item. */
  @Post('claims/:claimId/item-check')
  submit(
    @Req() req: Req,
    @Param('claimId', ParseIntPipe) claimId: number,
    @Body() dto: SubmitItemCheckDto,
  ) {
    return this.completion.submitItemCheck(req.user, claimId, dto, req);
  }

  /** Confirms the charity has seen a change made after they claimed. */
  @Post('changes/:changeId/acknowledge')
  acknowledge(@Req() req: Req, @Param('changeId', ParseIntPipe) changeId: number) {
    return this.completion.acknowledgeChange(req.user, changeId, req);
  }
}
