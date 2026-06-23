import {
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { DriverPickupStatus } from '@prisma/client';

export class GoLiveDto {
  @IsNumber()
  siteId!: number;

  @IsNumber()
  @Min(-90)
  @Max(90)
  lat!: number;

  @IsNumber()
  @Min(-180)
  @Max(180)
  lng!: number;

  @IsOptional()
  @IsString()
  vehicleType?: string;
}

export class GoOfflineDto {
  @IsNumber()
  siteId!: number;
}

export class AcceptPickupDto {
  @IsNumber()
  claimId!: number;

  @IsNumber()
  listingId!: number;
}

export class UpdatePickupStatusDto {
  @IsEnum(DriverPickupStatus)
  status!: DriverPickupStatus;
}

export class CompletePickupDto {
  @IsOptional()
  @IsString()
  notes?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5)
  rating?: number;
}
