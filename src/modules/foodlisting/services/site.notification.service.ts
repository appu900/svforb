import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { Jwtpayload } from '../../auth/interface/jwt.interface';
import { resolveCallerSiteId } from '../utils/resolve-caller-site';

@Injectable()
export class SiteNotificationService {
  constructor(private readonly prisma: PrismaService) {}

  // GET /food-listings/notifications — all active inbox notifications for caller's site
  async getInbox(caller: Jwtpayload, page = 1, limit = 20) {
    const siteId = await resolveCallerSiteId(this.prisma, caller);
    if (!siteId) return { notifications: [], total: 0, page, limit, totalPages: 0 };

    const now = new Date();
    const skip = (page - 1) * limit;

    const [notifications, total] = await Promise.all([
      this.prisma.siteNotification.findMany({
        where: { siteId, expiresAt: { gt: now } },
        include: {
          listing: {
            select: {
              id: true,
              totalQtyKg: true,
              remainingQtyKg: true,
              pickupAddress: true,
              bestBefore: true,
              status: true,
              listingType: true,
              photoUrls: true,
              site: { select: { organisationName: true } },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.siteNotification.count({
        where: { siteId, expiresAt: { gt: now } },
      }),
    ]);

    const unreadCount = await this.prisma.siteNotification.count({
      where: { siteId, expiresAt: { gt: now }, isRead: false },
    });

    return {
      notifications: notifications.map((n) => ({
        id: n.id,
        title: n.title,
        body: n.body,
        type: n.type,
        isRead: n.isRead,
        readAt: n.readAt,
        createdAt: n.createdAt,
        expiresAt: n.expiresAt,
        listing: n.listing,
      })),
      total,
      unreadCount,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  // PATCH /food-listings/notifications/:id/read
  async markRead(caller: Jwtpayload, notificationId: number) {
    const siteId = await resolveCallerSiteId(this.prisma, caller);
    const notification = await this.prisma.siteNotification.findFirst({
      where: { id: notificationId, ...(siteId ? { siteId } : {}) },
    });
    if (!notification) throw new NotFoundException('Notification not found');

    await this.prisma.siteNotification.update({
      where: { id: notificationId },
      data: { isRead: true, readAt: new Date() },
    });

    return { message: 'Marked as read' };
  }

  // PATCH /food-listings/notifications/read-all
  async markAllRead(caller: Jwtpayload) {
    const siteId = await resolveCallerSiteId(this.prisma, caller);
    if (!siteId) return { count: 0 };

    const { count } = await this.prisma.siteNotification.updateMany({
      where: { siteId, isRead: false, expiresAt: { gt: new Date() } },
      data: { isRead: true, readAt: new Date() },
    });

    return { message: `${count} notifications marked as read`, count };
  }
}
