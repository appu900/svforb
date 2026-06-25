import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as admin from 'firebase-admin';
import { BatchSendResult, FirebaseMessagePayload } from '../interfaces';
import {
  FCM_BATCH_SIZE,
  FCM_PARALLEL_BATCHES,
  UNREGISTERED_FCM_ERROR_CODES,
  TRANSIENT_FCM_ERROR_CODES,
} from '../constants';

@Injectable()
export class FirebaseGateway implements OnModuleInit {
  private readonly logger = new Logger(FirebaseGateway.name);
  private app: admin.app.App | null = null;

  constructor(private readonly config: ConfigService) {}

  onModuleInit() {
    const projectId = this.config.get<string>('FIREBASE_PROJECT_ID');
    const clientEmail = this.config.get<string>('FIREBASE_CLIENT_EMAIL');
    const privateKey = this.config.get<string>('FIREBASE_PRIVATE_KEY');

    if (!projectId || !clientEmail || !privateKey) {
      this.logger.warn(
        'Firebase credentials not configured — push notifications disabled',
      );
      return;
    }

    const resolvedKey = privateKey.replace(/\\n/g, '\n');

    try {
      try {
        this.app = admin.app();
        this.logger.log(`Reusing existing Firebase Admin app (project=${projectId})`);
      } catch {
        this.app = admin.initializeApp({
          credential: admin.credential.cert({ projectId, clientEmail, privateKey: resolvedKey }),
        });
        this.logger.log(`Firebase Admin SDK initialised (project=${projectId})`);
      }
    } catch (error) {
      this.logger.error(
        `Firebase Admin SDK init failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  isReady(): boolean {
    return !!this.app;
  }

  async sendToTokens(
    tokens: string[],
    payload: FirebaseMessagePayload,
  ): Promise<BatchSendResult> {
    if (!this.isReady()) {
      this.logger.error('Firebase not initialised — treating all tokens as retryable');
      return { successTokens: [], retryableTokens: tokens, invalidTokens: [] };
    }

    if (tokens.length === 0) {
      return { successTokens: [], retryableTokens: [], invalidTokens: [] };
    }

    const aggregated: BatchSendResult = {
      successTokens: [],
      retryableTokens: [],
      invalidTokens: [],
    };

    const chunks = this.chunkArray(tokens, FCM_BATCH_SIZE);

    for (let i = 0; i < chunks.length; i += FCM_PARALLEL_BATCHES) {
      const window = chunks.slice(i, i + FCM_PARALLEL_BATCHES);
      const results = await Promise.all(window.map((chunk) => this.sendBatch(chunk, payload)));

      for (const result of results) {
        aggregated.successTokens.push(...result.successTokens);
        aggregated.retryableTokens.push(...result.retryableTokens);
        aggregated.invalidTokens.push(...result.invalidTokens);
      }
    }

    this.logger.log(
      `FCM send complete: total=${tokens.length} success=${aggregated.successTokens.length} ` +
        `retryable=${aggregated.retryableTokens.length} invalid=${aggregated.invalidTokens.length}`,
    );

    return aggregated;
  }

  private async sendBatch(
    tokens: string[],
    payload: FirebaseMessagePayload,
  ): Promise<BatchSendResult> {
    const result: BatchSendResult = {
      successTokens: [],
      retryableTokens: [],
      invalidTokens: [],
    };

    const message: admin.messaging.MulticastMessage = {
      tokens,
      notification: {
        title: payload.title,
        body: payload.body,
        ...(payload.imageUrl ? { imageUrl: payload.imageUrl } : {}),
      },
      data: payload.data ?? {},
      android: {
        priority: payload.android?.priority === 'normal' ? 'normal' : 'high',
        notification: {
          channelId: payload.android?.channelId ?? 'default',
          sound: 'default',
          icon: 'notification_icon',
          color: '#4B2176',
        },
      },
      apns: {
        payload: {
          aps: {
            sound: payload.apns?.sound ?? 'default',
            ...(payload.apns?.badge !== undefined ? { badge: payload.apns.badge } : {}),
            ...(payload.apns?.category ? { category: payload.apns.category } : {}),
          },
        },
      },
    };

    try {
      const response = await admin.messaging(this.app!).sendEachForMulticast(message);

      response.responses.forEach((resp, idx) => {
        const token = tokens[idx];
        if (resp.success) {
          result.successTokens.push(token);
        } else {
          const errorCode = resp.error?.code ?? '';
          if (UNREGISTERED_FCM_ERROR_CODES.has(errorCode)) {
            result.invalidTokens.push(token);
          } else if (TRANSIENT_FCM_ERROR_CODES.has(errorCode)) {
            result.retryableTokens.push(token);
          } else {
            this.logger.warn(
              `Unknown FCM error — treating as retryable: code=${errorCode} token=${token.slice(0, 12)}…`,
            );
            result.retryableTokens.push(token);
          }
        }
      });
    } catch (error) {
      this.logger.error(
        `FCM batch send threw: ${error instanceof Error ? error.message : String(error)} (${tokens.length} tokens)`,
      );
      result.retryableTokens.push(...tokens);
    }

    return result;
  }

  private chunkArray<T>(arr: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < arr.length; i += size) {
      chunks.push(arr.slice(i, i + size));
    }
    return chunks;
  }
}
