import {
  Body, Controller, Get, Param, ParseIntPipe, Patch, Req, UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import { Request } from 'express';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { ConsolidatedEnabledGuard } from '../consolidated-enabled.guard';
import { Jwtpayload } from '../../auth/interface/jwt.interface';
import { DECLARATIONS } from '../consolidated.constants';
import { SetManagePermissionDto } from '../dto/permission.dto';
import { ConsolidatedAccessService } from '../services/consolidated-access.service';
import { ConsolidatedViewService } from '../services/consolidated-view.service';

type Req = Request & { user: Jwtpayload };

/**
 * What the caller may do, the declaration text they must agree to, and who
 * holds the manage permission.
 */
@Controller('consolidated')
@UseGuards(ConsolidatedEnabledGuard, JwtAuthGuard)
@ApiBearerAuth('bearer')
export class ConsolidatedAccessController {
  constructor(
    private readonly access: ConsolidatedAccessService,
    private readonly views: ConsolidatedViewService,
  ) {}

  /** What this user can do, so the client need not infer it from roles. */
  @Get('me')
  me(@Req() req: Req) {
    return this.views.me(req.user);
  }

  /**
   * The exact declaration wording. Served rather than hard-coded in the client
   * so a text change does not need an app release, and so the version the user
   * actually saw is the version stored with their signature.
   */
  @Get('declarations')
  declarations(@Req() req: Req) {
    this.access.assertProductAccess(req.user);
    return DECLARATIONS;
  }

  /** Org owner only. */
  @Get('permissions')
  listPermissions(@Req() req: Req) {
    return this.access.listPermissions(req.user);
  }

  /** Org owner only. Withdrawing also removes their manager memberships. */
  @Patch('permissions/:userId')
  setPermission(
    @Req() req: Req,
    @Param('userId', ParseIntPipe) userId: number,
    @Body() dto: SetManagePermissionDto,
  ) {
    return this.access.setPermission(req.user, userId, dto.canManageConsolidated, req);
  }
}
