import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsDateString,
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

  @IsOptional()
  @IsDateString()
  bestBefore?: string;

  @IsOptional()
  @IsDateString()
  pickupFromTime?: string;

  @IsOptional()
  @IsDateString()
  pickupByTime?: string;

  @IsNumber()
  @IsNotEmpty()
  pickupLat!: number;

  @IsNumber()
  @IsNotEmpty()
  pickupLng!: number;
}
