import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  EMAIL_QUEUE,
  EmailJobName,
  SendOtpPayload,
  SendPasswordResetPayload,
  SendWelcomePayload,
} from '../types/email.types';

const JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 5000 },
  removeOnComplete: { count: 100 },
  removeOnFail: { count: 50 },
};

@Injectable()
export class EmailQueueService {
  constructor(@InjectQueue(EMAIL_QUEUE) private readonly queue: Queue) {}

  async sendOtp(payload: SendOtpPayload): Promise<void> {
    await this.queue.add(EmailJobName.SEND_OTP, payload, JOB_OPTIONS);
  }

  async sendWelcome(payload: SendWelcomePayload): Promise<void> {
    await this.queue.add(EmailJobName.SEND_WELCOME, payload, JOB_OPTIONS);
  }

  async sendPasswordReset(payload: SendPasswordResetPayload): Promise<void> {
    await this.queue.add(
      EmailJobName.SEND_PASSWORD_RESET,
      payload,
      JOB_OPTIONS,
    );
  }
}
