import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { PlatformAdminGuard } from '../../common/guards/platform-admin.guard';
import { Jwtpayload } from '../auth/interface/jwt.interface';
import { SkipSubscriptionCheck } from './decorators/skip-subscription-check.decorator';
import { SubscriptionAccessService } from './services/subscription-access.service';
import { SubscriptionsService } from './subscriptions.service';
import {
  CreateSubscriptionPlanDto,
  UpdateSubscriptionPlanDto,
} from './dto/subscription.dto';
import { ApiBearerAuth } from '@nestjs/swagger';

/**
 * Exempt from the global subscription gate — an organisation with no plan must
 * still be able to see what it can buy and check its own billing state.
 */
@Controller('subscriptions')
@SkipSubscriptionCheck()
export class SubscriptionsController {
  constructor(
    private readonly subscriptionsService: SubscriptionsService,
    private readonly access: SubscriptionAccessService,
  ) {}

  /** Plans offered to the caller's organisation type. */
  @Get('available')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('bearer')
  findAvailable(@Req() req: Request & { user: Jwtpayload }) {
    return this.subscriptionsService.findAvailableForCaller(req.user);
  }

  /** What the caller's organisation is currently allowed to do. */
  @Get('me')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('bearer')
  myEntitlements(@Req() req: Request & { user: Jwtpayload }) {
    return this.access.getEntitlements(req.user);
  }

  @Post()
  @UseGuards(JwtAuthGuard, PlatformAdminGuard)
  @ApiBearerAuth('bearer')
  create(@Body() dto: CreateSubscriptionPlanDto) {
    return this.subscriptionsService.create(dto);
  }

  @Get()
  findAll() {
    return this.subscriptionsService.findAll();
  }

  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.subscriptionsService.findOne(id);
  }

  @Patch(':id')
  @UseGuards(JwtAuthGuard, PlatformAdminGuard)
  @ApiBearerAuth('bearer')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateSubscriptionPlanDto,
  ) {
    return this.subscriptionsService.update(id, dto);
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard, PlatformAdminGuard)
  @ApiBearerAuth('bearer')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.subscriptionsService.remove(id);
  }
}
