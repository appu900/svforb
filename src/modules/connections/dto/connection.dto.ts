import { Type } from 'class-transformer';
import {
  ArrayNotEmpty, IsArray, IsInt, IsNumber, IsOptional, IsString, MaxLength,
  Min, ValidateNested,
} from 'class-validator';

export class CreateConnectionDto {
  /** The business site offering surplus. */
  @Type(() => Number) @IsInt() donorSiteId!: number;

  /** The charity site that will collect — not just the charity organisation. */
  @Type(() => Number) @IsInt() receiverSiteId!: number;

  /** ISO weekdays, 1 = Monday … 7 = Sunday. */
  @IsArray() @ArrayNotEmpty() @Type(() => Number) @IsInt({ each: true })
  daysOfWeek!: number[];

  /** Local wall-clock at the donor site, 24-hour HH:MM. */
  @IsString() windowStart!: string;
  @IsString() windowEnd!: string;

  @Type(() => Number) @IsInt() @Min(0) @IsOptional() leadTimeMinutes?: number;
  @Type(() => Number) @IsInt() @Min(0) @IsOptional() cutoffMinutes?: number;

  @IsString() @IsOptional() @MaxLength(200) typicalSurplus?: string;
  @IsString() @IsOptional() @MaxLength(500) notes?: string;
}

export class UpdateConnectionDto {
  @IsArray() @IsOptional() @Type(() => Number) @IsInt({ each: true })
  daysOfWeek?: number[];

  @IsString() @IsOptional() windowStart?: string;
  @IsString() @IsOptional() windowEnd?: string;

  @Type(() => Number) @IsInt() @Min(0) @IsOptional() leadTimeMinutes?: number;
  @Type(() => Number) @IsInt() @Min(0) @IsOptional() cutoffMinutes?: number;

  @IsString() @IsOptional() @MaxLength(200) typicalSurplus?: string;
  @IsString() @IsOptional() @MaxLength(500) notes?: string;
}

export class SurplusItemDto {
  @IsString() @MaxLength(120) name!: string;
  @Type(() => Number) @IsNumber() @Min(0) quantityKg!: number;
  @IsString() @IsOptional() @MaxLength(120) category?: string;
}

/** Today's surplus. Site, window and charity come from the Connection. */
export class AddDailySurplusDto {
  @IsArray() @ArrayNotEmpty() @ValidateNested({ each: true }) @Type(() => SurplusItemDto)
  items!: SurplusItemDto[];

  @IsString() @IsOptional() @MaxLength(500) collectionNotes?: string;
}

export class DeclineDayDto {
  @IsString() @IsOptional() @MaxLength(300) reason?: string;
}

/** Sets the IANA zone a site's wall-clock schedules resolve against. */
export class SetSiteTimezoneDto {
  @IsString() @MaxLength(64) timezone!: string;
}

export class ReassignDayDto {
  @Type(() => Number) @IsInt() toConnectionId!: number;
}
