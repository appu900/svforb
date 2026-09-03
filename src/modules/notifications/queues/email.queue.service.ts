import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  EMAIL_QUEUE,
  EmailJobName,
  SendOtpPayload,
  SendPasswordResetPayload,
  SendEnterpriseInvitePayload,
  SendStaffInvitePayload,
  SendWelcomePayload,
} from '../types/email.types';
import { MailerService } from '../services/mailer.service';

const JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 5000 },
  removeOnComplete: { count: 100 },
  removeOnFail: { count: 50 },
};

@Injectable()
export class EmailQueueService {
  constructor(
    @InjectQueue(EMAIL_QUEUE) private readonly queue: Queue,
    private readonly mailer: MailerService,
  ) {}

  /** OTP is time-critical — send now, do not wait for the BullMQ worker. */
  async sendOtp(payload: SendOtpPayload): Promise<void> {
    await this.mailer.sendOtp(payload.to, payload.otp, payload.name);
  }

  async sendWelcome(payload: SendWelcomePayload): Promise<void> {
    await this.queue.add(EmailJobName.SEND_WELCOME, payload, JOB_OPTIONS);
  }

  async sendPasswordReset(payload: SendPasswordResetPayload): Promise<void> {
    await this.mailer.sendPasswordReset(
      payload.to,
      payload.resetToken,
      payload.name,
    );
  }

  async sendStaffInvite(payload: SendStaffInvitePayload): Promise<void> {
    await this.queue.add(EmailJobName.SEND_STAFF_INVITE, payload, JOB_OPTIONS);
  }

  async sendEnterpriseInvite(
    payload: SendEnterpriseInvitePayload,
  ): Promise<void> {
    await this.queue.add(
      EmailJobName.SEND_ENTERPRISE_INVITE,
      payload,
      JOB_OPTIONS,
    );
  }
}
