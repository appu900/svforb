import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { FoodListingType } from '@prisma/client';

export class CreateFoodItemDto {
  @IsString() @IsNotEmpty() name!: string;

  @IsNumber()
  @IsPositive()
  @Type(() => Number)
  totalQtyKg!: number;

  @IsString() @IsOptional() unit?: string;
  @IsString() @IsOptional() category?: string;
}

export class CreateFoodListingDto {
  @IsInt()
  @Type(() => Number)
  siteId!: number;

  @IsEnum(FoodListingType) listingType!: FoodListingType;

  @IsString() @IsNotEmpty() pickupAddress!: string;
  @IsString() @IsOptional() pickupPostcode?: string;

  @IsNumber() @Type(() => Number) pickupLat!: number;
  @IsNumber() @Type(() => Number) pickupLng!: number;

  @IsDateString() bestBefore!: string;
  @IsDateString() @IsOptional() pickupFromTime?: string;
  @IsDateString() @IsOptional() pickupByTime?: string;

  @IsBoolean() @IsOptional() needsRefrigeration?: boolean;
  @IsBoolean() @IsOptional() needsAmbient?: boolean;
  @IsBoolean() @IsOptional() needsFreezer?: boolean;
  @IsBoolean() @IsOptional() needsHot?: boolean;
  @IsBoolean() @IsOptional() needsReheating?: boolean;
  @IsBoolean() @IsOptional() isSafeForDonation?: boolean;

  @IsArray() @IsString({ each: true }) @IsOptional() allergens?: string[];
  @IsArray() @IsString({ each: true }) @IsOptional() photoUrls?: string[];

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateFoodItemDto)
  foodItems!: CreateFoodItemDto[];
}
