import {
  IsEmail,
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  MinLength,
} from 'class-validator';
import { Type } from 'class-transformer';
import { Region, VenueType } from '@prisma/client';

export class RegisterFarmerConsumerDto {
  @IsString() @IsNotEmpty() firstName!: string;
  @IsString() @IsNotEmpty() lastName!: string;
  @IsEmail() email!: string;
  @IsString() @MinLength(8) password!: string;
  @IsString() @IsOptional() mobile?: string;

  @IsString() @IsNotEmpty() farmName!: string;
  @IsString() @IsNotEmpty() businessName!: string;
  @IsString() @IsNotEmpty() address!: string;
  @IsString() @IsOptional() brandName?: string;
  @IsEnum(VenueType) @IsOptional() venueType?: VenueType;

  @IsEnum(Region) region!: Region;

  @IsNotEmpty()
  @Type(() => Number)
  @IsNumber()
  latitude!: number;

  @IsNotEmpty()
  @Type(() => Number)
  @IsNumber()
  longitude!: number;
}
