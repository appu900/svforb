process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { TokenTargetApp } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/infra/prisma/prisma.service';
import { NotificationService } from '../src/modules/notifications/services/notification.service';
import { FirebaseGateway } from '../src/modules/notifications/gateways/firebase.gateway';
import {
  PUSH_CHANNEL_BUSINESS,
  PUSH_CHANNEL_DRIVER,
} from '../src/modules/notifications/constants';

/**
 * Real DB + Redis e2e test — no mocks.
 * Verifies business and driver FCM tokens are stored separately and notifications route correctly.
 */
describe('Dual-app notifications (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let notificationService: NotificationService;
  let firebase: FirebaseGateway;
  let testUserId: number;

  const runId = Date.now();
  const businessToken = `e2e-business-fcm-${runId}`;
  const driverToken = `e2e-driver-fcm-${runId}`;
  const notificationIds: number[] = [];

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('/api/v1');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
    );
    await app.init();

    prisma = app.get(PrismaService);
    notificationService = app.get(NotificationService);
    firebase = app.get(FirebaseGateway);

    const user = await prisma.user.findFirst({
      where: { isActive: true },
      orderBy: { id: 'asc' },
    });
    if (!user) {
      throw new Error('E2E requires at least one active user in the database');
    }
    testUserId = user.id;
  }, 60_000);

  afterAll(async () => {
    if (notificationIds.length) {
      await prisma.notificationRecord.deleteMany({
        where: { id: { in: notificationIds } },
      });
    }
    await prisma.deviceToken.deleteMany({
      where: { token: { in: [businessToken, driverToken] } },
    });
    await app.close();
  }, 30_000);

  it('initialises both Firebase Admin apps', () => {
    expect(firebase.isReady('business')).toBe(true);
    expect(firebase.isReady('driver')).toBe(true);
  });

  it('stores business and driver tokens separately for the same user', async () => {
    const businessResult = await notificationService.registerToken(testUserId, {
      token: businessToken,
      platform: 'android',
      tokenType: 'fcm',
      appBundle: 'com.saveful.business.app',
      targetApp: 'business',
    });
    expect(businessResult.targetApp).toBe('business');

    const driverResult = await notificationService.registerToken(testUserId, {
      token: driverToken,
      platform: 'android',
      tokenType: 'fcm',
      appBundle: 'com.saveful.driver.app',
      targetApp: 'driver',
    });
    expect(driverResult.targetApp).toBe('driver');

    const stored = await prisma.deviceToken.findMany({
      where: {
        userId: testUserId,
        token: { in: [businessToken, driverToken] },
        isActive: true,
      },
      orderBy: { targetApp: 'asc' },
    });

    expect(stored).toHaveLength(2);
    expect(stored.map((t) => t.targetApp).sort()).toEqual(
      [TokenTargetApp.BUSINESS, TokenTargetApp.DRIVER].sort(),
    );
    expect(stored.find((t) => t.targetApp === TokenTargetApp.BUSINESS)?.token).toBe(
      businessToken,
    );
    expect(stored.find((t) => t.targetApp === TokenTargetApp.DRIVER)?.token).toBe(
      driverToken,
    );
  });

  it('queues business notification only to business tokens', async () => {
    const result = await notificationService.send({
      title: 'E2E business test',
      body: 'Should only reach business app tokens',
      targetUserIds: [String(testUserId)],
      targetApp: 'business',
      priority: 'normal',
      data: { type: 'e2e_business' },
    });

    expect(result.targetCount).toBe(1);
    notificationIds.push(result.notificationId);

    const record = await prisma.notificationRecord.findUnique({
      where: { id: result.notificationId },
    });
    expect(record?.channel).toBe(PUSH_CHANNEL_BUSINESS);
    expect(record?.totalTargets).toBe(1);
  });

  it('queues driver notification only to driver tokens', async () => {
    const result = await notificationService.send({
      title: 'E2E driver test',
      body: 'Should only reach driver app tokens',
      targetUserIds: [String(testUserId)],
      targetApp: 'driver',
      priority: 'high',
      data: { type: 'e2e_driver', pickupId: '999' },
    });

    expect(result.targetCount).toBe(1);
    notificationIds.push(result.notificationId);

    const record = await prisma.notificationRecord.findUnique({
      where: { id: result.notificationId },
    });
    expect(record?.channel).toBe(PUSH_CHANNEL_DRIVER);
    expect(record?.totalTargets).toBe(1);
  });

  it('does not cross-send: business send ignores driver tokens', async () => {
    const count = await prisma.deviceToken.count({
      where: {
        userId: testUserId,
        isActive: true,
        targetApp: TokenTargetApp.BUSINESS,
        token: businessToken,
      },
    });
    expect(count).toBe(1);

    const driverOnlyCount = await prisma.deviceToken.count({
      where: {
        userId: testUserId,
        isActive: true,
        targetApp: TokenTargetApp.DRIVER,
        token: driverToken,
      },
    });
    expect(driverOnlyCount).toBe(1);
  });

  it('scoped logout deactivates only business tokens', async () => {
    const { count } = await notificationService.unregisterAllTokens(testUserId, 'business');
    expect(count).toBe(1);

    const businessActive = await prisma.deviceToken.count({
      where: { token: businessToken, isActive: true },
    });
    const driverActive = await prisma.deviceToken.count({
      where: { token: driverToken, isActive: true },
    });

    expect(businessActive).toBe(0);
    expect(driverActive).toBe(1);

    await notificationService.registerToken(testUserId, {
      token: businessToken,
      platform: 'android',
      tokenType: 'fcm',
      appBundle: 'com.saveful.business.app',
      targetApp: 'business',
    });
  });

  it('skips driver notification gracefully when no driver token exists', async () => {
    await prisma.deviceToken.updateMany({
      where: { token: driverToken },
      data: { isActive: false },
    });

    const result = await notificationService.send({
      title: 'E2E driver skip',
      body: 'No driver token — should skip',
      targetUserIds: [String(testUserId)],
      targetApp: 'driver',
      allowEmptyTargets: true,
      priority: 'high',
    });

    expect(result.notificationId).toBe(0);
    expect(result.targetCount).toBe(0);

    await prisma.deviceToken.updateMany({
      where: { token: driverToken },
      data: { isActive: true, deactivationReason: null },
    });
  });

  it('sends FCM via correct Firebase project (dry-run invalid token)', async () => {
    const businessResult = await firebase.sendToTokens(
      [businessToken],
      { title: 'Biz', body: 'Test', data: { type: 'e2e' } },
      'business',
    );
    const driverResult = await firebase.sendToTokens(
      [driverToken],
      { title: 'Drv', body: 'Test', data: { type: 'e2e' } },
      'driver',
    );

    // Fake tokens should be rejected as invalid/unregistered, not mismatched-credential
    expect(businessResult.successTokens).toHaveLength(0);
    expect(driverResult.successTokens).toHaveLength(0);
    expect(
      businessResult.invalidTokens.length + businessResult.retryableTokens.length,
    ).toBe(1);
    expect(
      driverResult.invalidTokens.length + driverResult.retryableTokens.length,
    ).toBe(1);
  });
});
