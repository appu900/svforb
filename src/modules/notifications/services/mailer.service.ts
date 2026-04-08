import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import Mail from 'nodemailer/lib/mailer';

@Injectable()
export class MailerService {
  private readonly logger = new Logger(MailerService.name);
  private readonly transporter: nodemailer.Transporter;
  private readonly from: string;

  constructor(private readonly config: ConfigService) {
    this.from = this.config.get<string>('SMTP_FROM', 'noreply@example.com');

    this.transporter = nodemailer.createTransport({
      host: this.config.get<string>('SMTP_HOST'),
      port: this.config.get<number>('SMTP_PORT', 587),
      secure: this.config.get<string>('SMTP_SECURE') === 'true',
      auth: {
        user: this.config.get<string>('SMTP_USER'),
        pass: this.config.get<string>('SMTP_PASS'),
      },
    });
  }

  async sendMail(options: Mail.Options): Promise<void> {
    await this.transporter.sendMail({ from: this.from, ...options });
    this.logger.log(`Email sent to ${String(options.to)}`);
  }

  async sendOtp(to: string, otp: string, name?: string): Promise<void> {
    await this.sendMail({
      to,
      subject: 'Your OTP Verification Code',
      html: `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
          <h2 style="color:#333;">Email Verification</h2>
          <p>${name ? `Hello <strong>${name}</strong>,` : 'Hello,'}</p>
          <p>Use the code below to verify your email address:</p>
          <div style="background:#f4f4f4;padding:24px;text-align:center;border-radius:8px;margin:24px 0;">
            <h1 style="letter-spacing:12px;color:#1a1a1a;margin:0;">${otp}</h1>
          </div>
          <p>This code expires in <strong>10 minutes</strong>.</p>
          <p style="color:#888;font-size:13px;">If you did not request this, you can safely ignore this email.</p>
        </div>
      `,
    });
  }

  async sendWelcome(to: string, name: string): Promise<void> {
    await this.sendMail({
      to,
      subject: `Welcome, ${name}!`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
          <h2 style="color:#333;">Welcome aboard, ${name}!</h2>
          <p>Your account has been successfully created.</p>
          <p>You can now log in and start using our platform.</p>
          <p style="color:#888;font-size:13px;">If you have any questions, feel free to reach out to our support team.</p>
        </div>
      `,
    });
  }

  async sendStaffInvite(
    to: string,
    name: string,
    email: string,
    password: string,
    siteName: string,
    role: string,
  ): Promise<void> {
    await this.sendMail({
      to,
      subject: `You've been added to ${siteName}`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
          <h2 style="color:#333;">You've been added to ${siteName}</h2>
          <p>Hello <strong>${name}</strong>,</p>
          <p>You have been added to <strong>${siteName}</strong> as a <strong>${role}</strong>.</p>
          <p>Use the credentials below to log in:</p>
          <div style="background:#f4f4f4;padding:24px;border-radius:8px;margin:24px 0;">
            <p style="margin:0 0 8px;"><strong>Email:</strong> ${email}</p>
            <p style="margin:0;"><strong>Password:</strong> ${password}</p>
          </div>
          <p style="color:#e53e3e;font-size:13px;">For your security, please change your password after logging in for the first time.</p>
          <p style="color:#888;font-size:13px;">If you did not expect this invitation, please contact your organisation admin.</p>
        </div>
      `,
    });
  }

  async sendPasswordReset(
    to: string,
    resetToken: string,
    name?: string,
  ): Promise<void> {
    const appUrl = this.config.get<string>('APP_URL', 'http://localhost:3000');
    const resetUrl = `${appUrl}/reset-password?token=${resetToken}`;

    await this.sendMail({
      to,
      subject: 'Password Reset Request',
      html: `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
          <h2 style="color:#333;">Password Reset</h2>
          <p>${name ? `Hello <strong>${name}</strong>,` : 'Hello,'}</p>
          <p>Click the button below to reset your password. This link expires in <strong>1 hour</strong>.</p>
          <div style="text-align:center;margin:32px 0;">
            <a href="${resetUrl}"
               style="background:#007bff;color:#fff;padding:14px 28px;text-decoration:none;border-radius:6px;font-size:16px;">
              Reset Password
            </a>
          </div>
          <p style="color:#888;font-size:13px;">If you did not request a password reset, you can safely ignore this email.</p>
        </div>
      `,
    });
  }
}
