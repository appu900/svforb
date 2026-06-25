import { Injectable, Logger } from '@nestjs/common';
import { BatchSendResult, FirebaseMessagePayload } from '../interfaces';
import { EXPO_BATCH_SIZE } from '../constants';

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

interface ExpoPushMessage {
  to: string;
  title?: string;
  body?: string;
  data?: Record<string, string>;
  sound?: 'default' | null;
  badge?: number;
  channelId?: string;
  priority?: 'default' | 'normal' | 'high';
}

interface ExpoPushTicket {
  status: 'ok' | 'error';
  id?: string;
  message?: string;
  details?: { error?: string };
}

@Injectable()
export class ExpoGateway {
  private readonly logger = new Logger(ExpoGateway.name);

  async sendToTokens(
    tokens: string[],
    payload: FirebaseMessagePayload,
  ): Promise<BatchSendResult> {
    if (tokens.length === 0) {
      return { successTokens: [], retryableTokens: [], invalidTokens: [] };
    }

    const aggregated: BatchSendResult = {
      successTokens: [],
      retryableTokens: [],
      invalidTokens: [],
    };

    const chunks = this.chunkArray(tokens, EXPO_BATCH_SIZE);

    for (const chunk of chunks) {
      const result = await this.sendBatch(chunk, payload);
      aggregated.successTokens.push(...result.successTokens);
      aggregated.retryableTokens.push(...result.retryableTokens);
      aggregated.invalidTokens.push(...result.invalidTokens);
    }

    this.logger.log(
      `Expo push batch complete: success=${aggregated.successTokens.length} ` +
        `retryable=${aggregated.retryableTokens.length} invalid=${aggregated.invalidTokens.length}`,
    );

    return aggregated;
  }

  private async sendBatch(
    tokens: string[],
    payload: FirebaseMessagePayload,
  ): Promise<BatchSendResult> {
    const messages: ExpoPushMessage[] = tokens.map((to) => ({
      to,
      title: payload.title,
      body: payload.body,
      data: payload.data,
      sound: 'default',
      channelId: 'default',
      priority: 'high',
    }));

    const result: BatchSendResult = {
      successTokens: [],
      retryableTokens: [],
      invalidTokens: [],
    };

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15_000);

      const response = await fetch(EXPO_PUSH_URL, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Accept-Encoding': 'gzip, deflate',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(messages),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!response.ok) {
        this.logger.error(
          `Expo push API HTTP error: status=${response.status} ${response.statusText}`,
        );
        result.retryableTokens.push(...tokens);
        return result;
      }

      const json = (await response.json()) as { data: ExpoPushTicket[] };
      const tickets: ExpoPushTicket[] = json.data ?? [];

      tickets.forEach((ticket, i) => {
        const token = tokens[i];
        if (!token) return;

        if (ticket.status === 'ok') {
          result.successTokens.push(token);
        } else {
          const errCode = ticket.details?.error ?? '';
          this.logger.warn(
            `Expo push ticket error: token=${token.slice(0, 12)}… error=${ticket.message} code=${errCode}`,
          );

          if (errCode === 'DeviceNotRegistered') {
            result.invalidTokens.push(token);
          } else {
            result.retryableTokens.push(token);
          }
        }
      });
    } catch (err) {
      this.logger.error(
        `Expo push batch threw: ${err instanceof Error ? err.message : String(err)}`,
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
