export const EMAIL_QUEUE = 'email';

export enum EmailJobName {
  SEND_OTP = 'send-otp',
  SEND_WELCOME = 'send-welcome',
  SEND_PASSWORD_RESET = 'send-password-reset',
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
