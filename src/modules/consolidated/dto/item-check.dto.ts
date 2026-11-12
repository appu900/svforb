import { ConsolidatedRejectionReason } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayNotEmpty, IsArray, IsEnum, IsInt, IsNumber, IsOptional, IsString, Max,
  MaxLength, Min, ValidateNested,
} from 'class-validator';
import { DeclarationAcceptanceDto } from './contribution.dto';

export class ItemCheckLineDto {
  /** The master listing's FoodItem, which is what the charity actually sees. */
  @Type(() => Number) @IsInt() masterFoodItemId!: number;

  @Type(() => Number) @IsNumber() @Min(0) acceptedQtyKg!: number;
  @Type(() => Number) @IsNumber() @Min(0) rejectedQtyKg!: number;
  /** Listed and verified, but not actually there at pickup. */
  @Type(() => Number) @IsNumber() @Min(0) unavailableQtyKg!: number;

  /** Required whenever anything is rejected. */
  @IsEnum(ConsolidatedRejectionReason) @IsOptional()
  rejectionReason?: ConsolidatedRejectionReason;

  /** Required when the reason is OTHER. */
  @IsString() @IsOptional() @MaxLength(500) rejectionNote?: string;
}

export class SubmitItemCheckDto {
  @IsArray() @ArrayNotEmpty() @ValidateNested({ each: true }) @Type(() => ItemCheckLineDto)
  items!: ItemCheckLineDto[];

  @ValidateNested() @Type(() => DeclarationAcceptanceDto)
  declaration!: DeclarationAcceptanceDto;

  /** The existing collection rating, carried through unchanged. */
  @Type(() => Number) @IsInt() @Min(1) @Max(5) @IsOptional() rating?: number;
  @IsString() @IsOptional() @MaxLength(500) ratingNote?: string;
}
