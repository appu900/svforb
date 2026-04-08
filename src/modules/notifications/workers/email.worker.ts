import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { MailerService } from '../services/mailer.service';
import {
  EMAIL_QUEUE,
  EmailJobName,
  SendOtpPayload,
  SendPasswordResetPayload,
  SendStaffInvitePayload,
  SendWelcomePayload,
} from '../types/email.types';

@Processor(EMAIL_QUEUE)
export class EmailWorker extends WorkerHost {
  private readonly logger = new Logger(EmailWorker.name);

  constructor(private readonly mailerService: MailerService) {
    super();
  }

  async process(job: Job): Promise<void> {
    this.logger.log(`Processing job [${job.id}] name=${job.name}`);

    switch (job.name) {
      case EmailJobName.SEND_OTP: {
        const { to, otp, name } = job.data as SendOtpPayload;
        await this.mailerService.sendOtp(to, otp, name);
        break;
      }

      case EmailJobName.SEND_WELCOME: {
        const { to, name } = job.data as SendWelcomePayload;
        await this.mailerService.sendWelcome(to, name);
        break;
      }

      case EmailJobName.SEND_PASSWORD_RESET: {
        const { to, resetToken, name } = job.data as SendPasswordResetPayload;
        await this.mailerService.sendPasswordReset(to, resetToken, name);
        break;
      }

      case EmailJobName.SEND_STAFF_INVITE: {
        const { to, name, email, password, siteName, role } =
          job.data as SendStaffInvitePayload;
        await this.mailerService.sendStaffInvite(to, name, email, password, siteName, role);
        break;
      }

      default:
        this.logger.warn(`Unhandled job name: ${job.name}`);
    }
  }
}
