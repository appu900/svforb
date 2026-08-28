export const EMAIL_QUEUE = 'email';

export enum EmailJobName {
  SEND_OTP = 'send-otp',
  SEND_WELCOME = 'send-welcome',
  SEND_PASSWORD_RESET = 'send-password-reset',
  SEND_STAFF_INVITE = 'send-staff-invite',
  SEND_ENTERPRISE_INVITE = 'send-enterprise-invite',
}

export interface SendOtpPayload {
  to: string;
  otp: string;
  name?: string;
}

export interface SendWelcomePayload {
  to: string;
  name: string;
}

export interface SendPasswordResetPayload {
  to: string;
  resetToken: string;
  name?: string;
}

export interface SendStaffInvitePayload {
  to: string;
  name: string;
  email: string;
  password: string;
  siteName: string;
  role: string;
}

export interface SendEnterpriseInvitePayload {
  to: string;
  name: string;
  enterpriseName: string;
  role: string;
  /** Time-limited activation link. Never contains a password. */
  activationUrl: string;
  expiresInHours: number;
}
