import { ClaimMode } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsArray,
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
