export interface BatchSendResult {
  successTokens: string[];
  retryableTokens: string[];
  invalidTokens: string[];
  /**
   * The provider could not be reached because it is not configured, rather
   * than because of a transient fault.
   *
   * Retrying cannot fix a missing credential, so the worker fails the job
   * instead of requeuing — which is what puts it in the Failed tab where
   * somebody will see it. Treating this as retryable is what let push
   * delivery stay broken unnoticed.
   */
  configError?: string;
}

export interface FirebaseMessagePayload {
  title: string;
  body: string;
  data?: Record<string, string>;
  imageUrl?: string;
  apns?: {
    sound?: string;
    badge?: number;
    category?: string;
  };
  android?: {
    channelId?: string;
    sound?: string;
    priority?: 'high' | 'normal';
  };
}

export interface TokenWithType {
  token: string;
  tokenType: 'apns' | 'fcm' | 'expo';
  appBundle?: string | null;
}

export interface FanOutJobData {
  type: 'fan-out';
  notificationId: number;
}

export interface SendBatchJobData {
  type: 'send-batch';
  notificationId: number;
  tokens: TokenWithType[];
  batchIndex: number;
  totalBatches: number;
  /** 0 = first send. Extra waves are delayed retries, capped in notification-status. */
  retryGeneration?: number;
}

export type NotificationJobData = FanOutJobData | SendBatchJobData;
