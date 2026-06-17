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
import { OrgType, Region, VenueType } from '@prisma/client';

export class RegisterFarmerProducerDto {
  @IsString() @IsNotEmpty() firstName!: string;
  @IsString() @IsNotEmpty() lastName!: string;
  @IsEmail() email!: string;
  @IsString() @MinLength(8) password!: string;
  @IsString() @IsOptional() mobileNumber?: string;

  @IsString() @IsNotEmpty() businessName!: string;
  @IsString() @IsNotEmpty() businessAddress!: string;
  @IsString() @IsOptional() brandName?:string

  @IsEnum(VenueType) @IsOptional() venueType?: VenueType;
  @IsEnum(OrgType) orgType!: OrgType;
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
