import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import * as nodemailer from 'nodemailer';
import Mail from 'nodemailer/lib/mailer';

const LOGO_CID = 'saveful-logo@saveful';

@Injectable()
export class MailerService {
  private readonly logger = new Logger(MailerService.name);
  private readonly transporter: nodemailer.Transporter;
  private readonly from: string;
  private readonly logoPath: string | null;
  private readonly hostedLogoUrl: string;

  constructor(private readonly config: ConfigService) {
    this.from = this.config.get<string>('FROM_EMAIL', 'noreply@example.com');

    const explicitLogo = this.config.get<string>('EMAIL_LOGO_URL')?.trim();
    const frontendUrl = this.config
      .get<string>('FRONTEND_URL')
      ?.trim()
      .replace(/\/$/, '');
    this.hostedLogoUrl =
      explicitLogo || (frontendUrl ? `${frontendUrl}/logo.png` : '');

    this.logoPath = [
      path.join(__dirname, '..', 'assets', 'logo.png'),
      path.join(process.cwd(), 'public', 'logo.png'),
    ].find((candidate) => fs.existsSync(candidate)) ?? null;

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

  /**
   * Gmail and most webmail clients block data-URI images. Prefer an inline CID
   * attachment (works without a public fetch). Fall back to a hosted HTTPS URL.
   */
  private logoMarkup(maxWidth = 180): string {
    const src = this.logoPath
      ? `cid:${LOGO_CID}`
      : this.hostedLogoUrl;
    if (!src) return '';
    return `<div style="text-align:center;margin-bottom:24px;"><img src="${src}" alt="Saveful for Business" width="${maxWidth}" style="max-width:${maxWidth}px;height:auto;border:0;display:block;margin:0 auto;" /></div>`;
  }

  private logoAttachments(): Mail.Attachment[] {
    if (!this.logoPath) return [];
    return [
      {
        filename: 'logo.png',
        path: this.logoPath,
        cid: LOGO_CID,
        contentDisposition: 'inline',
        contentType: 'image/png',
      },
    ];
  }

  async sendMail(options: Mail.Options): Promise<void> {
    try {
      await this.transporter.sendMail({
        from: this.from,
        ...options,
        attachments: [...this.logoAttachments(), ...(options.attachments ?? [])],
      });
      this.logger.log(`Email sent to ${String(options.to)}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to send email to ${String(options.to)}: ${message}`);
      throw error;
    }
  }

  async sendOtp(to: string, otp: string, name?: string): Promise<void> {
  await this.sendMail({
  to,
  subject: 'Your verification code',
  text: `Your OTP is ${otp}. It expires in 10 minutes.`,
  html: `
    <div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;padding:20px;color:#333;">
      ${this.logoMarkup(180)}

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
          ${this.logoMarkup(200)}

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

  /**
   * Enterprise account activation. Carries a time-limited link and never a
   * password — administrators do not create passwords on behalf of users.
   */
  async sendEnterpriseInvite(payload: {
    to: string;
    name: string;
    enterpriseName: string;
    role: string;
    activationUrl: string;
    expiresInHours: number;
    invitedByName?: string;
    siteName?: string;
  }): Promise<void> {
    const {
      to,
      name,
      enterpriseName,
      role,
      activationUrl,
      expiresInHours,
      invitedByName,
      siteName,
    } = payload;
    const possessive = /s$/i.test(enterpriseName.trim())
      ? `${enterpriseName}'`
      : `${enterpriseName}'s`;
    const isSiteInvite = Boolean(siteName);
    const intro = isSiteInvite
      ? invitedByName
        ? `You've been invited by ${invitedByName} of ${possessive} Enterprise Account to manage ${siteName}.`
        : `You've been invited to manage ${siteName} for ${possessive} Enterprise Account.`
      : `You've been invited to manage ${possessive} Enterprise account.`;
    const subjectTarget = isSiteInvite ? siteName! : enterpriseName;
    const contextLabel = isSiteInvite ? 'Site' : 'Enterprise';
    const contextValue = isSiteInvite ? siteName! : enterpriseName;
    const cta = isSiteInvite
      ? 'Activate your account using your mobile only'
      : 'Activate your account';

    await this.sendMail({
      to,
      subject: `You have been invited to ${subjectTarget} on Saveful for Business`,
      text:
        `Hello ${name},\n\n` +
        `${intro}\n\n` +
        `${contextLabel}: ${contextValue}\n` +
        `Your role: ${role}\n\n` +
        `${cta}:\n${activationUrl}\n\n` +
        `This link expires in ${expiresInHours} hours. If it expires, ask your ` +
        `administrator to send a new invitation.\n\n` +
        `If you did not expect this invitation, you can safely ignore this email.`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
          ${this.logoMarkup(180)}
          <h2 style="color:#1a1a1a;margin-bottom:8px;">You&rsquo;ve been invited to Saveful for Business</h2>
          <p>Hello <strong>${name}</strong>,</p>
          <p>${
            isSiteInvite && invitedByName
              ? `You&rsquo;ve been invited by <strong>${invitedByName}</strong> of <strong>${possessive}</strong> Enterprise Account to manage <strong>${siteName}</strong>.`
              : isSiteInvite
                ? `You&rsquo;ve been invited to manage <strong>${siteName}</strong> for <strong>${possessive}</strong> Enterprise Account.`
                : `You&rsquo;ve been invited to manage <strong>${possessive}</strong> Enterprise account.`
          }</p>

          <table style="width:100%;border-collapse:collapse;margin:24px 0;background:#f6f8f6;border-radius:8px;">
            <tr>
              <td style="padding:16px 20px;border-bottom:1px solid #e6ebe6;">
                <div style="font-size:12px;color:#6b7d74;text-transform:uppercase;letter-spacing:.06em;">${contextLabel}</div>
                <div style="font-size:15px;color:#1a1a1a;font-weight:bold;">${contextValue}</div>
              </td>
            </tr>
            <tr>
              <td style="padding:16px 20px;">
                <div style="font-size:12px;color:#6b7d74;text-transform:uppercase;letter-spacing:.06em;">Your role</div>
                <div style="font-size:15px;color:#1a1a1a;font-weight:bold;">${role}</div>
              </td>
            </tr>
          </table>

          <p>Set your own password to activate your account:</p>
          <div style="text-align:center;margin:28px 0;">
            <a href="${activationUrl}"
               style="background:#1f5c43;color:#ffffff;text-decoration:none;padding:14px 32px;border-radius:8px;font-weight:bold;display:inline-block;">
              ${cta}
            </a>
          </div>

          <p style="font-size:13px;color:#666;">
            This link expires in <strong>${expiresInHours} hours</strong>.
            If it expires, ask your administrator to send a new invitation.
          </p>
          <p style="font-size:12px;color:#999;word-break:break-all;">
            If the button doesn&rsquo;t work, paste this into your browser:<br />${activationUrl}
          </p>

          <hr style="margin:24px 0;border:none;border-top:1px solid #eee;" />

          <p style="font-size:12px;color:#999;">
            If you did not expect this invitation, you can safely ignore this email.<br />
            Saveful for Business
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
          ${this.logoMarkup(180)}
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
