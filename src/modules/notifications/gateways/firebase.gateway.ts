import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as admin from 'firebase-admin';
import { BatchSendResult, FirebaseMessagePayload } from '../interfaces';
import {
  FCM_BATCH_SIZE,
  FCM_PARALLEL_BATCHES,
  NotificationTargetApp,
  TRANSIENT_FCM_ERROR_CODES,
  UNREGISTERED_FCM_ERROR_CODES,
} from '../constants';

const FIREBASE_APP_NAMES: Record<NotificationTargetApp, string> = {
  business: 'saveful-business',
  driver: 'saveful-b-driver',
};

@Injectable()
export class FirebaseGateway implements OnModuleInit {
  private readonly logger = new Logger(FirebaseGateway.name);
  private readonly apps: Partial<Record<NotificationTargetApp, admin.app.App>> = {};

  constructor(private readonly config: ConfigService) {}

  onModuleInit() {
    this.initApp('business', {
      projectId: this.config.get<string>('FIREBASE_PROJECT_ID'),
      clientEmail: this.config.get<string>('FIREBASE_CLIENT_EMAIL'),
      privateKey: this.config.get<string>('FIREBASE_PRIVATE_KEY'),
    });

    this.initApp('driver', {
      projectId: this.config.get<string>('FIREBASE_DRIVER_PROJECT_ID'),
      clientEmail: this.config.get<string>('FIREBASE_DRIVER_CLIENT_EMAIL'),
      privateKey: this.config.get<string>('FIREBASE_DRIVER_PRIVATE_KEY'),
    });
  }

  isReady(target: NotificationTargetApp = 'business'): boolean {
    return !!this.apps[target];
  }

  async sendToTokens(
    tokens: string[],
    payload: FirebaseMessagePayload,
    target: NotificationTargetApp = 'business',
  ): Promise<BatchSendResult> {
    const app = this.apps[target];

    if (!app) {
      this.logger.error(
        `Firebase (${target}) not initialised — treating all tokens as retryable`,
      );
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
      const results = await Promise.all(
        window.map((chunk) => this.sendBatch(app, chunk, payload, target)),
      );

      for (const result of results) {
        aggregated.successTokens.push(...result.successTokens);
        aggregated.retryableTokens.push(...result.retryableTokens);
        aggregated.invalidTokens.push(...result.invalidTokens);
      }
    }

    this.logger.log(
      `FCM send complete (${target}): total=${tokens.length} success=${aggregated.successTokens.length} ` +
        `retryable=${aggregated.retryableTokens.length} invalid=${aggregated.invalidTokens.length}`,
    );

    return aggregated;
  }

  private initApp(
    target: NotificationTargetApp,
    creds: { projectId?: string; clientEmail?: string; privateKey?: string },
  ): void {
    const { projectId, clientEmail, privateKey } = creds;

    if (!projectId || !clientEmail || !privateKey) {
      this.logger.warn(
        `Firebase credentials not configured for ${target} — ${target} push notifications disabled`,
      );
      return;
    }

    const appName = FIREBASE_APP_NAMES[target];
    const resolvedKey = privateKey.replace(/\\n/g, '\n');

    try {
      this.apps[target] = admin.app(appName);
      this.logger.log(`Reusing existing Firebase Admin app (${target}, project=${projectId})`);
    } catch {
      try {
        this.apps[target] = admin.initializeApp(
          {
            credential: admin.credential.cert({
              projectId,
              clientEmail,
              privateKey: resolvedKey,
            }),
          },
          appName,
        );
        this.logger.log(`Firebase Admin SDK initialised (${target}, project=${projectId})`);
      } catch (error) {
        this.logger.error(
          `Firebase Admin SDK init failed (${target}): ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  private async sendBatch(
    app: admin.app.App,
    tokens: string[],
    payload: FirebaseMessagePayload,
    target: NotificationTargetApp,
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
      data: stringifyFcmData(payload.data ?? {}),
      android: {
        priority: payload.android?.priority === 'normal' ? 'normal' : 'high',
        notification: {
          // Driver app listens on pickup_alarm_v3 with custom pickup_alert sound.
          channelId:
            payload.android?.channelId ??
            (target === 'driver' ? 'pickup_alarm_v3' : 'default'),
          sound:
            payload.android?.sound ??
            (target === 'driver' ? 'pickup_alert' : 'default'),
          icon: 'notification_icon',
          color: target === 'driver' ? '#1B5E20' : '#4B2176',
          ...(target === 'driver'
            ? { defaultVibrateTimings: true, priority: 'high' as const }
            : {}),
        },
      },
      apns: {
        payload: {
          aps: {
            sound:
              payload.apns?.sound ??
              (target === 'driver' ? 'pickup_alert.wav' : 'default'),
            ...(payload.apns?.badge !== undefined ? { badge: payload.apns.badge } : {}),
            ...(payload.apns?.category ? { category: payload.apns.category } : {}),
          },
        },
      },
    };

    try {
      const response = await admin.messaging(app).sendEachForMulticast(message);

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
              `Unknown FCM error (${target}) — treating as retryable: code=${errorCode} token=${token.slice(0, 12)}…`,
            );
            result.retryableTokens.push(token);
          }
        }
      });
    } catch (error) {
      this.logger.error(
        `FCM batch send threw (${target}): ${error instanceof Error ? error.message : String(error)} (${tokens.length} tokens)`,
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

/** FCM requires all data payload values to be strings. */
function stringifyFcmData(data: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined || value === null) continue;
    out[key] = typeof value === 'string' ? value : JSON.stringify(value);
  }
  return out;
}
