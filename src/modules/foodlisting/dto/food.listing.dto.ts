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
import { Transform, Type } from 'class-transformer';
import { FoodListingType } from '@prisma/client';

/** Multipart fields arrive as strings — parse JSON / booleans when needed. */
function ParseJsonIfString() {
  return Transform(({ value }) => {
    if (typeof value !== 'string') return value;
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  });
}

function ParseOptionalBoolean() {
  return Transform(({ value }) => {
    if (typeof value === 'boolean') return value;
    if (value === 'true' || value === '1') return true;
    if (value === 'false' || value === '0' || value === '') return false;
    return value;
  });
}

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

  @ParseOptionalBoolean()
  @IsBoolean()
  @IsOptional()
  needsRefrigeration?: boolean;

  @ParseOptionalBoolean()
  @IsBoolean()
  @IsOptional()
  needsAmbient?: boolean;

  @ParseOptionalBoolean()
  @IsBoolean()
  @IsOptional()
  needsFreezer?: boolean;

  @ParseOptionalBoolean()
  @IsBoolean()
  @IsOptional()
  needsHot?: boolean;

  @ParseOptionalBoolean()
  @IsBoolean()
  @IsOptional()
  needsReheating?: boolean;

  @ParseOptionalBoolean()
  @IsBoolean()
  @IsOptional()
  isSafeForDonation?: boolean;

  @ParseJsonIfString()
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  allergens?: string[];

  @ParseJsonIfString()
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  photoUrls?: string[];

  @ParseJsonIfString()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateFoodItemDto)
  foodItems!: CreateFoodItemDto[];
}
