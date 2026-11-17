import { FoodListingKind, FoodRecordStatus, FoodSource } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayNotEmpty, IsArray, IsBoolean, IsDateString, IsEnum, IsInt, IsNotEmpty,
  IsNumber, IsOptional, IsString, Max, MaxLength, Min, ValidateNested,
} from 'class-validator';
import { MAX_KG_PER_LINE, QTY_DECIMALS } from '../mfc.constants';

export class MfcCreateRecordDto {
  @Type(() => Number) @IsInt() siteId!: number;

  /** The app's own id for this submit, so a retry cannot make a second record. */
  @IsString() @IsNotEmpty() @MaxLength(100) clientRequestId!: string;

  @IsArray() @ArrayNotEmpty() @IsEnum(FoodSource, { each: true })
  sources!: FoodSource[];

  /** The service day this food belongs to. Defaults to now. */
  @IsDateString() @IsOptional() recordedAt?: string;
}

export class MfcLineDto {
  /** Stable across submits, so a full PUT can be diffed instead of replaced. */
  @IsString() @IsNotEmpty() @MaxLength(100) clientKey!: string;

  @IsEnum(FoodSource) source!: FoodSource;

  @IsString() @IsNotEmpty() @MaxLength(60) category!: string;
  @IsString() @IsOptional() @MaxLength(60) subtype?: string;

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: QTY_DECIMALS },
    { message: `A weight may have at most ${QTY_DECIMALS} decimal places.` })
  @Min(0.01, { message: 'A weight must be greater than zero.' })
  @Max(MAX_KG_PER_LINE, { message: `A single line cannot exceed ${MAX_KG_PER_LINE} kg.` })
  qtyKg!: number;

  /** Honoured only for Overproduction; the server forces false elsewhere. */
  @IsBoolean() @IsOptional() fitForHumans?: boolean;
}

/** The full intended set of lines — anything missing is soft-deleted. */
export class MfcPutLinesDto {
  @Type(() => Number) @IsInt() version!: number;

  @IsArray() @ValidateNested({ each: true }) @Type(() => MfcLineDto)
  lines!: MfcLineDto[];
}

export class MfcPatchRecordDto {
  @Type(() => Number) @IsInt() version!: number;

  @IsArray() @IsOptional() @ArrayNotEmpty() @IsEnum(FoodSource, { each: true })
  sources?: FoodSource[];

  @IsDateString() @IsOptional() recordedAt?: string;
}

export class MfcSaveRecordDto {
  @Type(() => Number) @IsInt() version!: number;
}

export class MfcRecordListQueryDto {
  @Type(() => Number) @IsInt() @IsOptional() siteId?: number;
  @IsEnum(FoodRecordStatus) @IsOptional() status?: FoodRecordStatus;

  @IsDateString() @IsOptional() from?: string;
  @IsDateString() @IsOptional() to?: string;

  /** The id of the last row of the previous page. */
  @Type(() => Number) @IsInt() @IsOptional() cursor?: number;
  @Type(() => Number) @IsInt() @Min(1) @Max(100) @IsOptional() limit?: number;
}

export class MfcListingPrefillQueryDto {
  @IsEnum(FoodListingKind) kind!: FoodListingKind;
}

/** One recorded line becoming one item on the listing being created. */
export class MfcListingItemLinkDto {
  @Type(() => Number) @IsInt() lineId!: number;
  /** Index into the request's own `foodItems` array. */
  @Type(() => Number) @IsInt() @Min(0) itemIndex!: number;
}

/**
 * The optional block an existing create-listing request may carry to tie the
 * listing back to a food record. Absent, the endpoint behaves exactly as before.
 */
export class MfcFoodRecordLinkDto {
  @Type(() => Number) @IsInt() recordId!: number;
  @IsEnum(FoodListingKind) kind!: FoodListingKind;

  @IsArray() @ArrayNotEmpty() @ValidateNested({ each: true }) @Type(() => MfcListingItemLinkDto)
  items!: MfcListingItemLinkDto[];
}
