import { Type } from 'class-transformer';
import {
  IsArray, IsBoolean, IsInt, IsNotEmpty, IsNumber, IsOptional, IsString, Min,
  MaxLength, ValidateNested,
} from 'class-validator';
import { DeclarationAcceptanceDto } from './contribution.dto';

export class VerifiedItemDto {
  /** The ConsolidatedItem (ledger) row, not the FoodItem. */
  @Type(() => Number) @IsInt() itemId!: number;

  /** What actually arrived. Zero excludes the item. */
  @Type(() => Number) @IsNumber() @Min(0) verifiedQtyKg!: number;
}

export class RecordReceiptDto {
  /** false records "nothing arrived from this site". */
  @IsBoolean() received!: boolean;

  /** Omit an item to accept the quantity the site submitted. */
  @IsArray() @IsOptional() @ValidateNested({ each: true }) @Type(() => VerifiedItemDto)
  items?: VerifiedItemDto[];

  @IsString() @IsOptional() @MaxLength(500) note?: string;
}

export class ExcludeContributionDto {
  @IsString() @IsNotEmpty() @MaxLength(500) reason!: string;
}

export class PublishDto {
  @ValidateNested() @Type(() => DeclarationAcceptanceDto)
  declaration!: DeclarationAcceptanceDto;
}
