import { TokenTargetApp } from '@prisma/client';

export const NOTIFICATION_QUEUE_NAME = 'notifications';

export type NotificationTargetApp = 'business' | 'driver';

export const BUSINESS_APP_BUNDLES = new Set([
  'com.saveful.business.app',
  'com.priteepriyadarshini.savefulbusiness',
]);

export const PUSH_CHANNEL_BUSINESS = 'push';
export const PUSH_CHANNEL_DRIVER = 'push:driver';

export function channelForTargetApp(targetApp: NotificationTargetApp): string {
  return targetApp === 'driver' ? PUSH_CHANNEL_DRIVER : PUSH_CHANNEL_BUSINESS;
}

export function targetAppFromChannel(channel: string | null | undefined): NotificationTargetApp {
  return channel === PUSH_CHANNEL_DRIVER ? 'driver' : 'business';
}

export function toPrismaTargetApp(targetApp: NotificationTargetApp): TokenTargetApp {
  return targetApp === 'driver' ? TokenTargetApp.DRIVER : TokenTargetApp.BUSINESS;
}

export function fromPrismaTargetApp(targetApp: TokenTargetApp): NotificationTargetApp {
  return targetApp === TokenTargetApp.DRIVER ? 'driver' : 'business';
}

/** Resolve which app a token belongs to at registration time. */
export function resolveTokenTargetApp(input: {
  targetApp?: NotificationTargetApp;
  appBundle?: string;
}): NotificationTargetApp {
  if (input.targetApp === 'driver' || input.targetApp === 'business') {
    return input.targetApp;
  }
  if (input.appBundle && BUSINESS_APP_BUNDLES.has(input.appBundle)) {
    return 'business';
  }
  if (input.appBundle) {
    return 'driver';
  }
  return 'business';
}

export const FCM_BATCH_SIZE = 500;
export const FCM_PARALLEL_BATCHES = 15;
export const EXPO_BATCH_SIZE = 100;

export const FAN_OUT_BATCH_SIZE = 1000;
export const WORKER_CONCURRENCY = 10;

export const JOB_ATTEMPTS = 3;
export const JOB_BACKOFF_TYPE = 'exponential' as const;
export const JOB_BACKOFF_DELAY = 60_000;
export const JOB_REMOVE_ON_COMPLETE = 1000;
export const JOB_REMOVE_ON_FAIL = 5000;

export const BULLMQ_PRIORITY = {
  high: 1,
  normal: 5,
  low: 10,
} as const;

export const TOKEN_FAILURE_THRESHOLD = 3;

export const BROADCAST_RATE_KEY = 'notif:broadcast:last';
export const BROADCAST_COOLDOWN_SECONDS = 300;

export const PRIORITY_WEIGHT: Record<string, number> = {
  low: 0,
  normal: 1,
  high: 2,
};

export const UNREGISTERED_FCM_ERROR_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
  'messaging/invalid-argument',
  'messaging/mismatched-credential',
]);

export const TRANSIENT_FCM_ERROR_CODES = new Set([
  'messaging/internal-error',
  'messaging/server-unavailable',
  'messaging/too-many-requests',
  'messaging/unavailable',
]);
