import {
  IsBoolean,
  IsEmail,
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  MinLength,
} from 'class-validator';
import { Type } from 'class-transformer';

export enum CharityMemberRole {
  HEAD_OFFICE_ADMIN = 'HEAD_OFFICE_ADMIN',
  HEAD_OFFICE = 'HEAD_OFFICE',
  LOCATION_ADMIN = 'LOCATION_ADMIN',
  TEAM_MEMBER = 'TEAM_MEMBER',
  DRIVER = 'DRIVER',
}

export class AddCharityLocationDto {
  @IsString() @IsNotEmpty() locationName!: string;
  @IsString() @IsNotEmpty() address!: string;
  @IsString() @IsNotEmpty() postcode!: string;
  @IsString() @IsNotEmpty() adminContactName!: string;
  @IsEmail() adminEmail!: string;
  @IsString() @IsNotEmpty() adminMobile!: string;
  @IsString() @MinLength(8) adminPassword!: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  radiusKm?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  latitude?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  longitude?: number;
}

export class UpdateCharityLocationDto {
  @IsString() @IsOptional() locationName?: string;
  @IsString() @IsOptional() address?: string;
  @IsString() @IsOptional() postcode?: string;
  @IsString() @IsOptional() contactName?: string;
  @IsEmail() @IsOptional() contactEmail?: string;
  @IsString() @IsOptional() contactMobile?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  radiusKm?: number;
}

export class AddCharityMemberDto {
  @IsString() @IsNotEmpty() firstName!: string;
  @IsString() @IsNotEmpty() lastName!: string;
  @IsEmail() email!: string;
  @IsString() @IsOptional() mobile?: string;
  @IsEnum(CharityMemberRole) role!: CharityMemberRole;
  @IsString() @MinLength(8) password!: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  locationId?: number;

  @IsBoolean() @IsOptional() canClaimPickupsDirectly?: boolean;
}

export class UpdateCharityMemberDto {
  @IsString() @IsOptional() firstName?: string;
  @IsString() @IsOptional() lastName?: string;
  @IsString() @IsOptional() mobile?: string;
  @IsBoolean() @IsOptional() canClaimPickupsDirectly?: boolean;
}

export class ResendInviteDto {
  @IsString() @MinLength(8) newPassword!: string;
}
