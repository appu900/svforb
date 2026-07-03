import {
  channelForTargetApp,
  PUSH_CHANNEL_BUSINESS,
  PUSH_CHANNEL_DRIVER,
  resolveTokenTargetApp,
  targetAppFromChannel,
  toPrismaTargetApp,
} from './constants';
import { TokenTargetApp } from '@prisma/client';

describe('notification constants (dual-app)', () => {
  describe('resolveTokenTargetApp', () => {
    it('uses explicit targetApp when provided', () => {
      expect(resolveTokenTargetApp({ targetApp: 'driver' })).toBe('driver');
      expect(resolveTokenTargetApp({ targetApp: 'business' })).toBe('business');
    });

    it('infers business from known business bundles', () => {
      expect(
        resolveTokenTargetApp({ appBundle: 'com.saveful.business.app' }),
      ).toBe('business');
    });

    it('infers driver from non-business bundle', () => {
      expect(
        resolveTokenTargetApp({ appBundle: 'com.saveful.driver.app' }),
      ).toBe('driver');
    });

    it('defaults to business when bundle is missing (legacy)', () => {
      expect(resolveTokenTargetApp({})).toBe('business');
    });

    it('explicit driver targetApp wins over business bundle', () => {
      expect(
        resolveTokenTargetApp({
          targetApp: 'driver',
          appBundle: 'com.saveful.business.app',
        }),
      ).toBe('driver');
    });
  });

  describe('channel routing', () => {
    it('maps targetApp to distinct push channels', () => {
      expect(channelForTargetApp('business')).toBe(PUSH_CHANNEL_BUSINESS);
      expect(channelForTargetApp('driver')).toBe(PUSH_CHANNEL_DRIVER);
      expect(targetAppFromChannel(PUSH_CHANNEL_DRIVER)).toBe('driver');
      expect(targetAppFromChannel(PUSH_CHANNEL_BUSINESS)).toBe('business');
    });
  });

  describe('toPrismaTargetApp', () => {
    it('maps to prisma enum values', () => {
      expect(toPrismaTargetApp('business')).toBe(TokenTargetApp.BUSINESS);
      expect(toPrismaTargetApp('driver')).toBe(TokenTargetApp.DRIVER);
    });
  });
});
