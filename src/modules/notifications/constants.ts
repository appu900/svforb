export const NOTIFICATION_QUEUE_NAME = 'notifications';

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
