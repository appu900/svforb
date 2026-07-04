import { IsEnum, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { VenueType } from '@prisma/client';

export class UpdateLocationDto {
  @IsNotEmpty()
  longitude!: number;

  @IsNotEmpty()
  latitude!: number;
}

export class UpdateOrganizationDto {
  @IsOptional()
  @IsString()
  brandName?: string;

  @IsOptional()
  @IsString()
  registrationNumber?: string;

  @IsOptional()
  @IsEnum(VenueType)
  venueType?: VenueType;
}
