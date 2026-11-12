import { Type } from 'class-transformer';
import {
  ArrayNotEmpty, IsArray, IsBoolean, IsDateString, IsInt, IsNotEmpty, IsNumber,
  IsOptional, IsPositive, IsString, MaxLength, ValidateNested,
} from 'class-validator';

/** The signature itself. The text is served by the API so both sides agree. */
export class DeclarationAcceptanceDto {
  @IsString() @IsNotEmpty() version!: string;
  @IsBoolean() accepted!: boolean;
}

export class ContributionItemDto {
  @IsString() @IsNotEmpty() @MaxLength(160) name!: string;

  @Type(() => Number) @IsNumber() @IsPositive() totalQtyKg!: number;

  @IsString() @IsOptional() @MaxLength(40) unit?: string;
  @IsString() @IsOptional() @MaxLength(80) category?: string;

  /** Display only, e.g. "12 trays". Kilograms stay authoritative (R15). */
  @IsString() @IsOptional() @MaxLength(80) quantityDescription?: string;
}

export class CreateContributionDto {
  @Type(() => Number) @IsInt() siteId!: number;

  @IsArray() @ArrayNotEmpty() @ValidateNested({ each: true }) @Type(() => ContributionItemDto)
  foodItems!: ContributionItemDto[];

  /** The food's own date. Never derived from the collection window (SPEC). */
  @IsDateString() bestBefore!: string;

  @IsBoolean() @IsOptional() needsRefrigeration?: boolean;
  @IsBoolean() @IsOptional() needsAmbient?: boolean;
  @IsBoolean() @IsOptional() needsFreezer?: boolean;
  @IsBoolean() @IsOptional() needsHot?: boolean;
  @IsBoolean() @IsOptional() needsReheating?: boolean;

  @IsArray() @IsOptional() @IsString({ each: true }) allergens?: string[];
  @IsArray() @IsOptional() @IsString({ each: true }) photoUrls?: string[];

  @IsString() @IsOptional() @MaxLength(1000) collectionNotes?: string;

  @ValidateNested() @Type(() => DeclarationAcceptanceDto)
  declaration!: DeclarationAcceptanceDto;
}

export class UpdateContributionDto {
  @IsArray() @IsOptional() @ArrayNotEmpty() @ValidateNested({ each: true })
  @Type(() => ContributionItemDto)
  foodItems?: ContributionItemDto[];

  @IsDateString() @IsOptional() bestBefore?: string;

  @IsBoolean() @IsOptional() needsRefrigeration?: boolean;
  @IsBoolean() @IsOptional() needsAmbient?: boolean;
  @IsBoolean() @IsOptional() needsFreezer?: boolean;
  @IsBoolean() @IsOptional() needsHot?: boolean;
  @IsBoolean() @IsOptional() needsReheating?: boolean;

  @IsArray() @IsOptional() @IsString({ each: true }) allergens?: string[];
  @IsArray() @IsOptional() @IsString({ each: true }) photoUrls?: string[];
  @IsString() @IsOptional() @MaxLength(1000) collectionNotes?: string;
}

export class WithdrawContributionDto {
  @IsString() @IsOptional() @MaxLength(500) reason?: string;
}

export class LateDecisionDto {
  @IsString() @IsOptional() @MaxLength(500) reason?: string;
}

export class ChangeRequestDecisionDto {
  @IsString() @IsOptional() @MaxLength(500) reason?: string;
}
