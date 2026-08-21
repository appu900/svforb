import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import * as nodemailer from 'nodemailer';
import Mail from 'nodemailer/lib/mailer';

@Injectable()
export class MailerService {
  private readonly logger = new Logger(MailerService.name);
  private readonly transporter: nodemailer.Transporter;
  private readonly from: string;
  private readonly logoDataUri: string;

  constructor(private readonly config: ConfigService) {
    this.from = this.config.get<string>('FROM_EMAIL', 'noreply@example.com');
    console.log(this.from)

    const logoPath = path.join(process.cwd(), 'public', 'logo.png');
    try {
      const logoBuffer = fs.readFileSync(logoPath);
      this.logoDataUri = `data:image/png;base64,${logoBuffer.toString('base64')}`;
    } catch {
      this.logoDataUri = '';
    }

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
  subject: 'Your verification code',
  text: `Your OTP is ${otp}. It expires in 10 minutes.`,
  html: `
    <div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;padding:20px;color:#333;">
      ${this.logoDataUri ? `<div style="text-align:center;margin-bottom:24px;"><img src="${this.logoDataUri}" alt="Saveful for Business" style="max-width:180px;height:auto;" /></div>` : ''}

      <p>${name ? `Hi ${name},` : 'Hi,'}</p>

      <p>Thanks for signing up to Saveful for Business. Please use the verification code below to complete your sign-in on the app:</p>

      <div style="font-size:28px;font-weight:bold;letter-spacing:6px;
                  background:#f6f6f6;padding:16px;text-align:center;
                  border-radius:6px;margin:20px 0;">
        ${otp}
      </div>

      <p style="margin:0;">This code will expire in 10 minutes.</p>

      <p style="margin-top:20px;font-size:12px;color:#777;">
        If you didn’t request this, you can ignore this email.
      </p>

      <hr style="margin:20px 0;border:none;border-top:1px solid #eee;" />

      <p style="font-size:12px;color:#999;">
        Saveful • Secure Authentication Service
      </p>

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
    _role: string,
  ): Promise<void> {
    const appStoreUrl = 'https://apps.apple.com/us/app/saveful/id6460647948';
    const playStoreUrl = 'https://play.google.com/store/apps/details?id=com.saveful.app';
    const businessUrl = 'https://www.saveful.com/business';

    await this.sendMail({
      to,
      subject: 'Welcome to Saveful for Business - Your account is ready',
      html: `
        <div style="font-family:Arial,Helvetica,sans-serif;max-width:600px;margin:0 auto;color:#333;line-height:1.5;">
          ${
            this.logoDataUri
              ? `<div style="text-align:center;margin:0 0 28px;">
                  <img src="${this.logoDataUri}" alt="Saveful for Business" style="max-width:200px;height:auto;" />
                </div>`
              : ''
          }

          <p style="margin:0 0 16px;">Hello ${name},</p>

          <h2 style="margin:0 0 12px;font-size:22px;font-weight:700;color:#1a1a1a;">
            Welcome to Saveful for Business
          </h2>

          <p style="margin:0 0 16px;">
            You've been invited to join the <strong>${siteName}</strong> team on Saveful for Business.
          </p>

          <p style="margin:0 0 20px;">
            Saveful for Business helps organisations recover more surplus food,
            connect with recovery partners and measure their environmental and social impact.
          </p>

          <p style="margin:0 0 12px;">
            To get started, download the Saveful for Business app and sign in using the login details below:
          </p>

          <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto 28px;border-collapse:collapse;">
            <tr>
              <td valign="middle" height="48" style="height:48px;padding:0 5px;vertical-align:middle;">
                <a href="${appStoreUrl}"
                   style="display:block;box-sizing:border-box;width:156px;height:48px;background:#000000;
                          color:#ffffff;text-decoration:none;border-radius:8px;text-align:center;">
                  <span style="display:block;padding:7px 10px 0;font-size:9px;line-height:1;letter-spacing:0.2px;">Download on the</span>
                  <span style="display:block;padding:3px 10px 0;font-size:16px;line-height:1.1;font-weight:600;">App Store</span>
                </a>
              </td>
              <td valign="middle" height="48" style="height:48px;padding:0 5px;vertical-align:middle;">
                <a href="${playStoreUrl}"
                   style="display:block;box-sizing:border-box;width:156px;height:48px;background:#000000;
                          color:#ffffff;text-decoration:none;border-radius:8px;text-align:center;">
                  <span style="display:block;padding:7px 10px 0;font-size:9px;line-height:1;letter-spacing:0.2px;">GET IT ON</span>
                  <span style="display:block;padding:3px 10px 0;font-size:16px;line-height:1.1;font-weight:600;">Google Play</span>
                </a>
              </td>
            </tr>
          </table>

          <p style="margin:0 0 8px;font-weight:700;">Your login details</p>
          <div style="background:#f4f4f4;padding:20px 24px;border-radius:8px;margin:0 0 28px;">
            <p style="margin:0 0 8px;"><strong>Email:</strong> ${email}</p>
            <p style="margin:0;"><strong>Temporary Password:</strong> ${password}</p>
          </div>

          <div style="text-align:center;margin:0 0 28px;">
            <a href="${businessUrl}"
               style="display:inline-block;background:#1a1a1a;color:#ffffff;text-decoration:none;
                      padding:12px 22px;border-radius:6px;font-size:14px;font-weight:600;">
              Learn more about Saveful for Business &nbsp;&rsaquo;
            </a>
          </div>

          <p style="margin:0 0 16px;font-weight:700;">
            Together, we're helping good food go further.
          </p>

          <p style="margin:0 0 12px;font-size:13px;color:#555;">
            For your security, please change your password after logging in for the first time.
          </p>

          <p style="margin:0;font-size:13px;color:#888;">
            If you did not expect this invitation, please contact your organisation administrator.
          </p>
        </div>
      `,
    });
  }

  async sendPasswordReset(
    to: string,
    otp: string,
    name?: string,
  ): Promise<void> {
    await this.sendMail({
      to,
      subject: 'Password Reset Code',
      text: `Your password reset code is ${otp}. It expires in 1 hour.`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
          ${this.logoDataUri ? `<div style="text-align:center;margin-bottom:24px;"><img src="${this.logoDataUri}" alt="Saveful for Business" style="max-width:180px;height:auto;" /></div>` : ''}
          <h2 style="color:#333;">Password Reset</h2>
          <p>${name ? `Hello <strong>${name}</strong>,` : 'Hello,'}</p>
          <p>Use the code below to reset your password:</p>
          <div style="background:#f4f4f4;padding:24px;text-align:center;border-radius:8px;margin:24px 0;">
            <h1 style="letter-spacing:12px;color:#1a1a1a;margin:0;">${otp}</h1>
          </div>
          <p>This code expires in <strong>1 hour</strong>.</p>
          <p style="color:#888;font-size:13px;">If you did not request a password reset, you can safely ignore this email.</p>

          <hr style="margin:20px 0;border:none;border-top:1px solid #eee;" />

          <p style="font-size:12px;color:#999;">
            Saveful &bull; Secure Authentication Service
          </p>
        </div>
      `,
    });
  }
}
