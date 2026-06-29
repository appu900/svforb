import { Logger, Injectable } from '@nestjs/common';
import { RedisService } from '../../../infra/redis/redis.service';

const normalizeEmail = (email: string) => email.trim().toLowerCase();

const K = {
  EMAIL_OTP: (email: string) => `auth:otp:email:${normalizeEmail(email)}`,
  RESET_TOKEN: (email: string) => `auth:otp:reset:${normalizeEmail(email)}`,
  REFRESH_TOKEN: (token: string) => `auth:refresh:${token}`,
  TOKEN_BLACKLIST: (jti: string) => `auth:blacklist:${jti}`,
  LOGIN_ATTEMPTS: (email: string) => `auth:login_attempts:${normalizeEmail(email)}`,
  USER_PROFILE: (userId: string) => `cache:user:${userId}`,
  ORG_PLAN: (orgId: string) => `cache:org:plan:${orgId}`,
} as const;

const TTL = {
  EMAIL_OTP: 30 * 60, // 30 min — allow time for email delivery
  RESET_OTP: 60 * 60, // 1 hour
  REFRESH_TOKEN: 7 * 24 * 60 * 60, // 7 days
  BLACKLIST: 60 * 60, // 1 hour (matches JWT expiry)
  LOGIN_ATTEMPTS: 15 * 60, // 15 min sliding window
  USER_PROFILE: 5 * 60, // 5 min
  ORG_PLAN: 10 * 60, // 10 min
} as const;

@Injectable()
export class AuthCacheManager {
  private readonly logger = new Logger(AuthCacheManager.name);
  constructor(private readonly redisService: RedisService) {}

  async storeEmailVerificationOtp(email: string, otp: string): Promise<void> {
    return await this.redisService.set(K.EMAIL_OTP(email), otp, TTL.EMAIL_OTP);
  }

  async getEmailVerifyOtp(email: string): Promise<string | null> {
    return await this.redisService.get(K.EMAIL_OTP(email));
  }

  async revokeEmailVerifyOtp(email: string): Promise<void> {
    await this.redisService.del(K.EMAIL_OTP(email));
  }


  async incrementLoginattempts(email:string){
    const key = K.LOGIN_ATTEMPTS(email)
    const current = await this.redisService.get(key);
    const next = current ? parseInt(current,10) + 1 : 1;
    await this.redisService.set(key,next.toString(),TTL.LOGIN_ATTEMPTS)
    return next;
  }

  async clearLoginAttempts(email:string){
    const key = K.LOGIN_ATTEMPTS(email)
    await this.redisService.del(key);
  }

  async storePasswordResetOtp(email: string, otp: string): Promise<void> {
    await this.redisService.set(K.RESET_TOKEN(email), otp, TTL.RESET_OTP);
  }

  async getPasswordResetOtp(email: string): Promise<string | null> {
    return this.redisService.get(K.RESET_TOKEN(email));
  }

  async revokePasswordResetOtp(email: string): Promise<void> {
    await this.redisService.del(K.RESET_TOKEN(email));
  }
}
