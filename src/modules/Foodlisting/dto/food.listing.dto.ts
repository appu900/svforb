import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';

export class FoodItemDto {
  @IsString()
  @IsNotEmpty()
  category!: string;

  @IsNumber()
  @IsPositive()
  totalQtyKg!: number;

  @IsNumber()
  @Min(0)
  remainingQtyKg!: number;
}

export class CreateListingDto {
  @IsNumber()
  siteId!: number;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => FoodItemDto)
  foodItems!: FoodItemDto[];

  @IsString()
  pickupAddress!: string;

  @IsOptional()
  @IsString()
  pickupPostcode?: string;

  @IsDateString()
  bestBefore!: string;

  @IsOptional()
  @IsDateString()
  pickupFromTime?: string;

  @IsOptional()
  @IsDateString()
  pickupByTime?: string;

  @IsOptional()
  @IsBoolean()
  needsRefrigeration?: boolean;

  @IsOptional()
  @IsBoolean()
  needsReheating?: boolean;

  @IsOptional()
  @IsBoolean()
  containsAllergens?: boolean;
}

export class RelistDto {
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => FoodItemDto)
  foodItems?: FoodItemDto[];

  @IsDateString()
  bestBefore!: string;

  @IsOptional()
  @IsDateString()
  pickupFromTime?: string;

  @IsOptional()
  @IsDateString()
  pickupByTime?: string;

  @IsOptional()
  @IsNumber()
  pickupLat?: number;

  @IsOptional()
  @IsNumber()
  pickupLng?: number;
}

export class UpdateListingDto {
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => FoodItemDto)
  foodItems?: FoodItemDto[];

  @IsOptional()
  @IsDateString()
  bestBefore?: string;

  @IsOptional()
  @IsDateString()
  pickupFromTime?: string;

  @IsOptional()
  @IsDateString()
  pickupByTime?: string;

  @IsOptional()
  @IsBoolean()
  needsRefrigeration?: boolean;

  @IsOptional()
  @IsBoolean()
  needsReheating?: boolean;

  @IsOptional()
  @IsBoolean()
  containsAllergens?: boolean;

  @IsOptional()
  @IsBoolean()
  isGlutenFree?: boolean;

  @IsOptional()
  @IsBoolean()
  isSafeForDonation?: boolean;
}

export class GetListingsQueryDto {
  @IsOptional()
  @IsIn(['ACTIVE', 'PARTIAL', 'CLAIMED', 'EXPIRED', 'CANCELLED'])
  status?: string;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Type(() => Number)
  page?: number;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Type(() => Number)
  limit?: number;
}
