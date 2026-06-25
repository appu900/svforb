import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { TokenPlatform, TokenType } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { RedisService } from 'src/infra/redis/redis.service';
import { NotificationProducer } from '../producers/notification.producer';
import { RegisterTokenDto } from '../dto/register-token.dto';
import {
  BROADCAST_COOLDOWN_SECONDS,
  BROADCAST_RATE_KEY,
  PRIORITY_WEIGHT,
} from '../constants';

export interface SendNotificationInput {
  title: string;
  body: string;
  data?: Record<string, string>;
  deepLink?: string;
  imageUrl?: string;
  priority?: 'low' | 'normal' | 'high';
  targetUserIds?: string[];
  isBroadcast?: boolean;
  scheduledAt?: string;
  targetPlatform?: 'all' | 'ios' | 'android';
}

@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly producer: NotificationProducer,
  ) {}


  async registerToken(
    userId: number,
    dto: RegisterTokenDto,
  ): Promise<{ message: string }> {
    const platform =
      dto.platform === 'ios' ? TokenPlatform.IOS : TokenPlatform.ANDROID;
    const tokenType =
      dto.tokenType === 'apns'
        ? TokenType.APNS
        : dto.tokenType === 'expo'
          ? TokenType.EXPO
          : TokenType.FCM;

    const existing = await this.prisma.deviceToken.findUnique({
      where: { token: dto.token },
    });

    if (existing) {
      await this.prisma.deviceToken.update({
        where: { token: dto.token },
        data: {
          userId,
          platform,
          tokenType,
          tokenMode: dto.tokenMode ?? 'prod',
          appVersion: dto.appVersion,
          appBuild: dto.appBuild,
          appBundle: dto.appBundle,
          isActive: true,
          failureCount: 0,
          deactivationReason: null,
        },
      });
      this.logger.log(`Device token re-registered: userId=${userId} platform=${dto.platform}`);
      return { message: 'Token updated' };
    }

    await this.prisma.deviceToken.create({
      data: {
        userId,
        token: dto.token,
        platform,
        tokenType,
        tokenMode: dto.tokenMode ?? 'prod',
        appVersion: dto.appVersion,
        appBuild: dto.appBuild,
        appBundle: dto.appBundle,
      },
    });

    this.logger.log(`Device token registered: userId=${userId} platform=${dto.platform}`);
    return { message: 'Token registered' };
  }

  async unregisterToken(userId: number, token: string): Promise<{ message: string }> {
    const result = await this.prisma.deviceToken.updateMany({
      where: { userId, token },
      data: {
        isActive: false,
        deactivationReason: 'user_disabled',
        lastFailureAt: new Date(),
      },
    });

    if (result.count === 0) {
      throw new NotFoundException('Token not found for this user');
    }
    return { message: 'Token unregistered' };
  }

  async unregisterAllTokens(userId: number): Promise<{ count: number }> {
    const result = await this.prisma.deviceToken.updateMany({
      where: { userId, isActive: true },
      data: {
        isActive: false,
        deactivationReason: 'user_disabled_all',
        lastFailureAt: new Date(),
      },
    });
    return { count: result.count };
  }


  async send(
    input: SendNotificationInput,
    createdById?: number,
  ): Promise<{ notificationId: number; message: string; targetCount: number }> {
    if (
      !input.isBroadcast &&
      (!input.targetUserIds || input.targetUserIds.length === 0)
    ) {
      throw new BadRequestException(
        'Must specify targetUserIds or set isBroadcast = true',
      );
    }

    if (input.isBroadcast) {
      const raw = await this.redis.get(BROADCAST_RATE_KEY);
      if (raw) {
        const lastBroadcast = parseInt(raw, 10);
        const elapsed = (Date.now() - lastBroadcast) / 1000;
        if (elapsed < BROADCAST_COOLDOWN_SECONDS) {
          throw new ConflictException(
            `Broadcast cooldown: wait ${Math.ceil(BROADCAST_COOLDOWN_SECONDS - elapsed)}s before sending another broadcast`,
          );
        }
      }
      await this.redis.set(BROADCAST_RATE_KEY, String(Date.now()), BROADCAST_COOLDOWN_SECONDS);
    }

    const priority = input.priority ?? 'normal';
    const isBroadcast = input.isBroadcast ?? false;
    const targetUserIds = input.targetUserIds?.map((id) => parseInt(id, 10)) ?? [];
    const targetPlatform = input.targetPlatform ?? 'all';

    const tokenWhere: any = { isActive: true };
    if (!isBroadcast && targetUserIds.length > 0) {
      tokenWhere.userId = { in: targetUserIds };
    } else if (!isBroadcast) {
      tokenWhere._id = { equals: -1 };
    }
    if (targetPlatform !== 'all') {
      tokenWhere.platform =
        targetPlatform === 'ios' ? TokenPlatform.IOS : TokenPlatform.ANDROID;
    }

    const targetCount = await this.prisma.deviceToken.count({ where: tokenWhere });

    if (targetCount === 0) {
      throw new BadRequestException(
        'No active mobile device tokens found for this audience',
      );
    }

    const notif = await this.prisma.notificationRecord.create({
      data: {
        title: input.title,
        body: input.body,
        data: input.data ?? {},
        deepLink: input.deepLink,
        imageUrl: input.imageUrl,
        priority,
        priorityWeight: PRIORITY_WEIGHT[priority] ?? 1,
        targetUserIds,
        isBroadcast,
        targetPlatform,
        totalTargets: targetCount,
        scheduledAt: input.scheduledAt ? new Date(input.scheduledAt) : undefined,
        createdById,
        status: 'queued',
      },
    });

    const delayMs = input.scheduledAt
      ? Math.max(0, new Date(input.scheduledAt).getTime() - Date.now())
      : 0;

    await this.producer.enqueueNotification(
      notif.id,
      priority as 'high' | 'normal' | 'low',
      delayMs > 0 ? delayMs : undefined,
    );

    this.logger.log(
      `Notification queued: id=${notif.id} isBroadcast=${isBroadcast} targetCount=${targetCount} platform=${targetPlatform} scheduled=${!!input.scheduledAt}`,
    );

    return {
      notificationId: notif.id,
      targetCount,
      message: input.scheduledAt
        ? `Notification scheduled for ${input.scheduledAt} to ${targetCount} mobile devices`
        : `Notification queued for delivery to ${targetCount} mobile devices`,
    };
  }

  async dispatchExisting(id: number): Promise<{ message: string }> {
    const notif = await this.prisma.notificationRecord.findUnique({ where: { id } });
    if (!notif) throw new NotFoundException('Notification not found');

    const delayMs = notif.scheduledAt
      ? Math.max(0, new Date(notif.scheduledAt).getTime() - Date.now())
      : 0;

    await this.prisma.notificationRecord.update({
      where: { id },
      data: { status: 'queued' },
    });

    await this.producer.enqueueNotification(
      id,
      (notif.priority as 'high' | 'normal' | 'low') ?? 'normal',
      delayMs > 0 ? delayMs : undefined,
    );

    this.logger.log(`Existing notification ${id} dispatched to queue`);

    return {
      message: notif.scheduledAt
        ? `Notification scheduled for ${notif.scheduledAt.toISOString()}`
        : 'Notification queued for delivery',
    };
  }


  async getStats() {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const [
      totalTokens,
      activeTokens,
      iosTokens,
      androidTokens,
      queuedNotifications,
      sentToday,
      queueStats,
    ] = await Promise.all([
      this.prisma.deviceToken.count(),
      this.prisma.deviceToken.count({ where: { isActive: true } }),
      this.prisma.deviceToken.count({ where: { isActive: true, platform: TokenPlatform.IOS } }),
      this.prisma.deviceToken.count({ where: { isActive: true, platform: TokenPlatform.ANDROID } }),
      this.prisma.notificationRecord.count({ where: { status: { in: ['queued', 'processing'] } } }),
      this.prisma.notificationRecord.count({
        where: {
          status: { in: ['sent', 'partially_sent'] },
          completedAt: { gte: todayStart },
        },
      }),
      this.producer.getQueueStats(),
    ]);

    return {
      totalTokens,
      activeTokens,
      iosTokens,
      androidTokens,
      queuedNotifications,
      sentToday,
      queue: queueStats,
    };
  }

  async getNotifications(page = 1, limit = 20, status?: string) {
    const where = status ? { status } : {};
    const [notifications, total] = await Promise.all([
      this.prisma.notificationRecord.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.notificationRecord.count({ where }),
    ]);
    return { notifications, total, page, pages: Math.ceil(total / limit) };
  }

  async getNotificationById(id: number) {
    const notif = await this.prisma.notificationRecord.findUnique({ where: { id } });
    if (!notif) throw new NotFoundException('Notification not found');
    return notif;
  }
}
