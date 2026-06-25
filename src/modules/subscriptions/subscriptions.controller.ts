import {
  Body,
  Controller,
  Delete,
  Get,
  Logger,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { PlatformAdminGuard } from '../../common/guards/platform-admin.guard';
import { SubscriptionsService } from './subscriptions.service';
import {
  CreateSubscriptionPlanDto,
  UpdateSubscriptionPlanDto,
} from './dto/subscription.dto';

@Controller('subscriptions')

export class SubscriptionsController {
  constructor(private readonly subscriptionsService: SubscriptionsService) {}
  @Post()
  @UseGuards(JwtAuthGuard, PlatformAdminGuard)
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
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateSubscriptionPlanDto,
  ) {
    return this.subscriptionsService.update(id, dto);
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard, PlatformAdminGuard)
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.subscriptionsService.remove(id);
  }
}


