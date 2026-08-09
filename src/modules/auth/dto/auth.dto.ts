import {
  IsEmail,
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  MinLength,
} from 'class-validator';
import { OrgType, Region, VenueType } from '@prisma/client';
import {Type} from "class-transformer"

export class RegisterBusinessDto {
  @IsString() @IsNotEmpty() firstName!: string;
  @IsString() @IsNotEmpty() lastName!: string;
  @IsEmail() email!: string;
  @IsString() @MinLength(8) password!: string;
  @IsString() @IsOptional() mobile!: string;
  @IsString() @IsNotEmpty() businessName!: string;
  @IsString() @IsNotEmpty() businessAddress!: string;
  @IsString() @IsOptional() registrationNumber?: string;
  @IsString() @IsOptional() brandName?:string
  @IsEnum(VenueType) @IsOptional() venueType?: VenueType;
  @IsEnum(OrgType) orgType!: OrgType; 
  @IsEnum(Region) region!: Region;
  @IsNotEmpty()
  @Type(() => Number)
  @IsNumber()
  latitude!: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  longitude!: number;
}

export class RegisterCharityDto {
  @IsString() @IsNotEmpty() firstName!: string;
  @IsString() @IsNotEmpty() lastName!: string;
  @IsEmail() email!: string;
  @IsString() @MinLength(8) password!: string;
  @IsString() @IsOptional() mobile?: string;
  @IsString() @IsNotEmpty() charityName!: string;
  @IsString() @IsNotEmpty() charityAddress!: string;
  @IsString() @IsOptional() registrationNumber?: string;
  @IsString() @IsOptional() brandName?: string;
  @IsEnum(Region) region!: Region;
  @IsOptional() @Type(() => Number) @IsNumber() latitude?: number;
  @IsOptional() @Type(() => Number) @IsNumber() longitude?: number;

  // CHARITY_SINGLE or CHARITY_MULTI
  @IsEnum(OrgType) charityType!: OrgType;

  // Pickup preferences: required for CHARITY_SINGLE; used for default HQ site on CHARITY_MULTI
  @IsString() @IsOptional() pickupPostCode?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  pickupRadiusKm?: number;
}

export class LoginDto {
  @IsEmail() email!: string;
  @IsString() @IsNotEmpty() password!: string;
}

export class VerifyEmailDto {
  @IsString() @IsNotEmpty() token!: string;
}

export class VerifyEmailOtpDto {
  @IsEmail() email!: string;
  @IsString() @IsNotEmpty() otp!: string;
}

export class ResendVerificationDto {
  @IsEmail() email!: string;
}

export class ForgotPasswordDto {
  @IsEmail() email!: string;
}

export class ResetPasswordDto {
  @IsEmail() email!: string;
  @IsString() @IsNotEmpty() otp!: string;
  @IsString() @MinLength(8) newPassword!: string;
}

export class RefreshTokenDto {
  @IsString() @IsNotEmpty() refreshToken!: string;
}

export class RegisterPlatformAdminDto {
  @IsString() @IsNotEmpty() firstName!: string;
  @IsString() @IsNotEmpty() lastName!: string;
  @IsEmail() email!: string;
  @IsString() @MinLength(8) password!: string;
}

export class JoinTeamDto {
  @IsString() @IsNotEmpty() inviteCode!: string;
}

export class UpdateProfileDto {
  @IsString() @IsNotEmpty() phoneNumber!: string;
}


