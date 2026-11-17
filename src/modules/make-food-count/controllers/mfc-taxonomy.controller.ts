import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import { Request } from 'express';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { Jwtpayload } from '../../auth/interface/jwt.interface';
import { TAXONOMY_PAYLOAD } from '../mfc.constants';
import { MfcAccessService } from '../services/mfc-access.service';

type Req = Request & { user: Jwtpayload };

/**
 * The food categories the app renders.
 *
 * Served rather than compiled into the app so labels can change without a
 * release. The app binds to `key`; `taxonomyVersion` tells it when the set
 * itself has moved.
 */
@Controller('mfc')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth('bearer')
export class MfcTaxonomyController {
  constructor(private readonly access: MfcAccessService) {}

  @Get('taxonomy')
  async taxonomy(@Req() req: Req) {
    // Receiver organisations have no reach, so this 404s for them like the rest.
    await this.access.assertCanReadInsights(req.user);
    return TAXONOMY_PAYLOAD;
  }
}
