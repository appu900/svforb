import { ClaimMode } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Max,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

class ClaimItemDto {
  @IsInt()
  foodItemId!: number;

  @IsNumber()
  @IsPositive()
  qtyKg!: number;
}

export class CreateClaimDto {
  @IsInt()
  listingId!: number;

  @IsEnum(ClaimMode)
  claimMode!: ClaimMode;

  @ValidateIf((o) => o.claimMode === ClaimMode.PARTIAL)
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ClaimItemDto)
  claimItems?: ClaimItemDto[];
}

export class MarkCollectedDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5)
  rating?: number;

  @IsOptional()
  @IsString()
  ratingNote?: string;
}

/** Rate a claim after collection (or while confirming collection). */
export class RateClaimDto {
  @IsInt()
  @Min(1)
  @Max(5)
  rating!: number;

  @IsOptional()
  @IsString()
  ratingNote?: string;
}

/** Listing provider (restaurant) confirms collection and rates the claimant. */
export class ProviderFeedbackDto {
  @IsBoolean()
  didCollect!: boolean;

  @ValidateIf((o) => o.didCollect === true)
  @IsInt()
  @Min(1)
  @Max(5)
  rating?: number;

  @IsOptional()
  @IsString()
  ratingNote?: string;
}
