import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as admin from 'firebase-admin';

const FCM_CHUNK_SIZE = 500;

@Injectable()
export class FirebaseService implements OnModuleInit {
  private readonly logger = new Logger(FirebaseService.name);
  private messaging!: admin.messaging.Messaging;

  constructor(private readonly config: ConfigService) {}

  onModuleInit() {
    const app =
      admin.apps.length > 0
        ? admin.apps[0]!
        : admin.initializeApp({
            credential: admin.credential.cert({
              projectId: this.config.getOrThrow<string>('FIREBASE_PROJECT_ID'),
              clientEmail: this.config.getOrThrow<string>('FIREBASE_CLIENT_EMAIL'),
              privateKey: this.config
                .getOrThrow<string>('FIREBASE_PRIVATE_KEY')
                .replace(/\\n/g, '\n'),
            }),
          });

    this.messaging = app.messaging();
    this.logger.log('Firebase Admin initialised');
  }

  async sendMulticast(
    tokens: string[],
    notification: { title: string; body: string },
    data?: Record<string, string>,
  ): Promise<void> {
    if (!tokens.length) return;

    const chunks = this.chunk(tokens, FCM_CHUNK_SIZE);

    await Promise.all(
      chunks.map((chunk) => this.sendChunk(chunk, notification, data)),
    );
  }

  private async sendChunk(
    tokens: string[],
    notification: { title: string; body: string },
    data?: Record<string, string>,
  ): Promise<void> {
    const message: admin.messaging.MulticastMessage = {
      tokens,
      notification,
      data,
      android: { priority: 'high' },
      apns: { payload: { aps: { sound: 'default', badge: 1 } } },
    };

    const response = await this.messaging.sendEachForMulticast(message);

    this.logger.log(
      `FCM multicast: success=${response.successCount} failure=${response.failureCount}`,
    );

    response.responses.forEach((r, i) => {
      if (!r.success) {
        this.logger.warn(`FCM token[${i}] failed: ${r.error?.message}`);
      }
    });
  }

  private chunk<T>(arr: T[], size: number): T[][] {
    const result: T[][] = [];
    for (let i = 0; i < arr.length; i += size) {
      result.push(arr.slice(i, i + size));
    }
    return result;
  }
}
