import {
  IsEmail,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  MinLength,
} from 'class-validator';
import { Type } from 'class-transformer';

export class CreateSiteDto {
  @IsString() @IsNotEmpty() siteName!: string;
  @IsString() @IsNotEmpty() address!: string;
  @IsString() @IsNotEmpty() postcode!: string;
  @IsString() @IsNotEmpty() contactName!: string;
  @IsEmail() contactEmail!: string;
  @IsString() @IsOptional() phoneNumber?: string;

  @IsNotEmpty()
  @Type(() => Number)
  @IsNumber()
  latitude!: number;

  @IsNotEmpty()
  @Type(() => Number)
  @IsNumber()
  longitude!: number;
}

export class AssignSiteManagerDto {
  @IsString() @IsNotEmpty() firstName!: string;
  @IsString() @IsNotEmpty() lastName!: string;
  @IsEmail() email!: string;
  @IsString() @MinLength(8) password!: string;
  @IsString() @IsOptional() phoneNumber?: string;
}

export class AddStaffDto {
  @IsString() @IsNotEmpty() firstName!: string;
  @IsString() @IsNotEmpty() lastName!: string;
  @IsEmail() email!: string;
  @IsString() @MinLength(8) password!: string;
  @IsString() @IsOptional() phoneNumber?: string;
}

export class UpdateSiteDto {
  @IsString() @IsNotEmpty() @IsOptional() siteName?: string;
  @IsString() @IsNotEmpty() @IsOptional() address?: string;
  @IsString() @IsOptional() postcode?: string;
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
}
