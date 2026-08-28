import {
  IsArray,
  IsEmail,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';

const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;

export class CreateSiteDto {
  @IsString() @IsNotEmpty() @MaxLength(160) siteName!: string;
  @IsString() @IsNotEmpty() address!: string;
  @IsString() @IsOptional() @MaxLength(20) postcode?: string;
  /** Optional override. When omitted the API assigns SITE-000123 from the new row id. */
  @IsString() @IsOptional() @MaxLength(40) siteCode?: string;

  @IsString() @IsOptional() @MaxLength(120) contactName?: string;
  @IsEmail() @IsOptional() contactEmail?: string;
  @IsString() @IsOptional() @MaxLength(30) phoneNumber?: string;

  @IsNotEmpty()
  @Type(() => Number)
  @IsNumber()
  latitude!: number;

  @IsNotEmpty()
  @Type(() => Number)
  @IsNumber()
  longitude!: number;

  @IsArray()
  @IsOptional()
  @IsIn(WEEKDAYS, { each: true })
  collectionDays?: string[];

  @IsString() @IsOptional() collectionStartTime?: string;
  @IsString() @IsOptional() collectionEndTime?: string;
  @IsString() @IsOptional() @MaxLength(500) collectionInstructions?: string;

  @Type(() => Number) @IsInt() @IsOptional() groupId?: number;
  @Type(() => Number) @IsInt() @IsOptional() clusterId?: number;
  @Type(() => Number) @IsInt() @IsOptional() territoryId?: number;
}

export class AssignSiteManagerDto {
  @IsString() @IsNotEmpty() firstName!: string;
  @IsString() @IsNotEmpty() lastName!: string;
  @IsEmail() email!: string;
  @IsString() @MinLength(8) password!: string;
  @IsString() @IsOptional() phoneNumber?: string;
}

/** Existing org member — no password. They already have (or will set) their own. */
export class AssignExistingSiteAdminDto {
  @Type(() => Number)
  @IsInt()
  userId!: number;
}

export class AddStaffDto {
  @IsString() @IsNotEmpty() firstName!: string;
  @IsString() @IsNotEmpty() lastName!: string;
  @IsEmail() email!: string;
  @IsString() @MinLength(8) password!: string;
  @IsString() @IsOptional() phoneNumber?: string;
}

export class UpdateSiteDto {
  @IsString() @IsNotEmpty() @IsOptional() @MaxLength(160) siteName?: string;
  @IsString() @IsNotEmpty() @IsOptional() address?: string;
  @IsString() @IsOptional() @MaxLength(20) postcode?: string;
  @IsString() @IsOptional() @MaxLength(40) siteCode?: string;
  @IsString() @IsNotEmpty() @IsOptional() contactName?: string;
  @IsEmail() @IsOptional() contactEmail?: string;
  @IsString() @IsOptional() phoneNumber?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  latitude?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  longitude?: number;

  @IsArray()
  @IsOptional()
  @IsIn(WEEKDAYS, { each: true })
  collectionDays?: string[];

  @IsString() @IsOptional() collectionStartTime?: string;
  @IsString() @IsOptional() collectionEndTime?: string;
  @IsString() @IsOptional() @MaxLength(500) collectionInstructions?: string;

  @Transform(({ value }) => {
    if (value === undefined) return undefined;
    if (value === null || value === '') return null;
    return Number(value);
  })
  @IsInt()
  @IsOptional()
  groupId?: number | null;

  @Transform(({ value }) => {
    if (value === undefined) return undefined;
    if (value === null || value === '') return null;
    return Number(value);
  })
  @IsInt()
  @IsOptional()
  clusterId?: number | null;

  @Transform(({ value }) => {
    if (value === undefined) return undefined;
    if (value === null || value === '') return null;
    return Number(value);
  })
  @IsInt()
  @IsOptional()
  territoryId?: number | null;
}
