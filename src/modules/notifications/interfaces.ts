export interface BatchSendResult {
  successTokens: string[];
  retryableTokens: string[];
  invalidTokens: string[];
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
    priority?: 'high' | 'normal';
  };
}

export interface TokenWithType {
  token: string;
  tokenType: 'apns' | 'fcm' | 'expo';
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
}

export type NotificationJobData = FanOutJobData | SendBatchJobData;
