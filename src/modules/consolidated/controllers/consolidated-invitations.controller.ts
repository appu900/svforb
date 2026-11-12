import {
  Body, Controller, Get, Param, ParseIntPipe, Post, Req, UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import { Request } from 'express';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { ConsolidatedEnabledGuard } from '../consolidated-enabled.guard';
import { Jwtpayload } from '../../auth/interface/jwt.interface';
import { DeclineInvitationDto } from '../dto/group.dto';
import { ConsolidatedGroupService } from '../services/consolidated-group.service';

type Req = Request & { user: Jwtpayload };

/**
 * A site joins a collection group only when someone who runs it accepts
 * (Canva CM1). Answered by the site's Site Admins — or by the organisation's
 * owner/admins for a site nobody administers.
 */
@Controller('consolidated/invitations')
@UseGuards(ConsolidatedEnabledGuard, JwtAuthGuard)
@ApiBearerAuth('bearer')
export class ConsolidatedInvitationsController {
  constructor(private readonly groups: ConsolidatedGroupService) {}

  /** Pending invitations this user can answer. */
  @Get()
  list(@Req() req: Req) {
    return this.groups.listInvitations(req.user);
  }

  @Post(':id/accept')
  accept(@Req() req: Req, @Param('id', ParseIntPipe) id: number) {
    return this.groups.respondToInvitation(req.user, id, true, undefined, req);
  }

  @Post(':id/decline')
  decline(
    @Req() req: Req,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: DeclineInvitationDto,
  ) {
    return this.groups.respondToInvitation(req.user, id, false, dto.reason, req);
  }
}
