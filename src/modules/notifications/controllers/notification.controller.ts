import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { PlatformAdminGuard } from '../../../common/guards/platform-admin.guard';
import { Jwtpayload } from '../../../modules/auth/interface/jwt.interface';
import { NotificationService } from '../services/notification.service';
import { NotificationProducer } from '../producers/notification.producer';
import { RegisterTokenDto, UnregisterTokenDto } from '../dto/register-token.dto';
import { SendNotificationDto } from '../dto/send-notification.dto';

@Controller('notifications')
export class NotificationController {
  constructor(
    private readonly notificationService: NotificationService,
    private readonly notificationProducer: NotificationProducer,
  ) {}

  @Get('ping')
  ping() {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }

  @Post('token')
  @UseGuards(JwtAuthGuard)
  async registerToken(
    @Body() dto: RegisterTokenDto,
    @Req() req: Request & { user: Jwtpayload },
  ) {
    return this.notificationService.registerToken(req.user.sub, dto);
  }

  @Delete('token')
  @UseGuards(JwtAuthGuard)
  async unregisterToken(
    @Body() dto: UnregisterTokenDto,
    @Req() req: Request & { user: Jwtpayload },
  ) {
    return this.notificationService.unregisterToken(req.user.sub, dto.token);
  }

  @Delete('tokens/all')
  @UseGuards(JwtAuthGuard)
  async unregisterAllTokens(
    @Req() req: Request & { user: Jwtpayload },
    @Query('targetApp') targetApp?: 'business' | 'driver',
  ) {
    return this.notificationService.unregisterAllTokens(req.user.sub, targetApp);
  }

  @Post('send')
  @UseGuards(JwtAuthGuard, PlatformAdminGuard)
  async sendNotification(
    @Body() dto: SendNotificationDto,
    @Req() req: Request & { user: Jwtpayload },
  ) {
    return this.notificationService.send(
      {
        title: dto.title,
        body: dto.body,
        data: dto.data,
        deepLink: dto.deepLink,
        imageUrl: dto.imageUrl,
        priority: dto.priority,
        targetUserIds: dto.targetUserIds,
        isBroadcast: dto.isBroadcast,
        scheduledAt: dto.scheduledAt,
        targetPlatform: dto.targetPlatform,
        targetApp: dto.targetApp,
      },
      req.user.sub,
    );
  }

  @Post('dispatch/:id')
  @UseGuards(JwtAuthGuard, PlatformAdminGuard)
  async dispatchNotification(@Param('id', ParseIntPipe) id: number) {
    return this.notificationService.dispatchExisting(id);
  }

  @Get('stats')
  @UseGuards(JwtAuthGuard, PlatformAdminGuard)
  async getStats() {
    return this.notificationService.getStats();
  }

  @Get('queue/stats')
  @UseGuards(JwtAuthGuard, PlatformAdminGuard)
  async getQueueStats() {
    return this.notificationProducer.getQueueStats();
  }

  @Post('queue/retry-failed')
  @UseGuards(JwtAuthGuard, PlatformAdminGuard)
  async retryFailed() {
    const count = await this.notificationProducer.retryAllFailed();
    return { retriedCount: count, message: `Retried ${count} failed jobs` };
  }

  @Post('queue/drain')
  @UseGuards(JwtAuthGuard, PlatformAdminGuard)
  async drainQueue() {
    await this.notificationProducer.drain();
    return { message: 'Queue drained — all pending jobs removed' };
  }

  @Get()
  @UseGuards(JwtAuthGuard, PlatformAdminGuard)
  async getNotifications(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('status') status?: string,
  ) {
    return this.notificationService.getNotifications(
      page ? parseInt(page, 10) : 1,
      limit ? parseInt(limit, 10) : 20,
      status,
    );
  }

  @Get(':id')
  @UseGuards(JwtAuthGuard, PlatformAdminGuard)
  async getNotification(@Param('id', ParseIntPipe) id: number) {
    return this.notificationService.getNotificationById(id);
  }
}
