import { ConsolidatedHandoverMethod, ConsolidatedRecurrence } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsArray, IsDateString, IsEnum, IsInt, IsNotEmpty, IsOptional, IsString,
  Matches, Max, MaxLength, Min,
} from 'class-validator';

/** Wall-clock HH:mm in the group's timezone, never an instant. */
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const TIME_MESSAGE = 'Use a 24-hour time such as 14:30.';

export class CreateScheduleDto {
  @Type(() => Number) @IsInt() collectionPointId!: number;

  @IsEnum(ConsolidatedHandoverMethod) method!: ConsolidatedHandoverMethod;
  @IsEnum(ConsolidatedRecurrence) recurrence!: ConsolidatedRecurrence;

  @IsDateString() startDate!: string;
  @IsDateString() @IsOptional() endDate?: string;

  /** ISO weekdays, 1 = Monday … 7 = Sunday. */
  @IsArray() @IsOptional() @Type(() => Number) @IsInt({ each: true })
  daysOfWeek?: number[];

  @IsArray() @IsOptional() @IsDateString({}, { each: true })
  customDates?: string[];

  @Type(() => Number) @IsInt() @Min(0) @Max(30) @IsOptional()
  opensDaysBefore?: number;

  @Matches(HHMM, { message: `Submissions close time: ${TIME_MESSAGE}` })
  submissionsCloseTime!: string;
  @Matches(HHMM, { message: `Handover start time: ${TIME_MESSAGE}` })
  handoverStartTime!: string;
  @Matches(HHMM, { message: `Handover end time: ${TIME_MESSAGE}` })
  handoverEndTime!: string;
  @Matches(HHMM, { message: `Pickup start time: ${TIME_MESSAGE}` })
  pickupStartTime!: string;
  @Matches(HHMM, { message: `Pickup end time: ${TIME_MESSAGE}` })
  pickupEndTime!: string;

  @IsString() @IsNotEmpty() @MaxLength(120) contactName!: string;
  @IsString() @IsNotEmpty() @MaxLength(30) contactPhone!: string;
  @IsString() @IsOptional() @MaxLength(1000) instructions?: string;

  /** What the sites must meet for food to be included. Shown on every screen. */
  @IsString() @IsNotEmpty() @MaxLength(1000) suitabilityNotes!: string;

  /** Empty or omitted means every active site in the group. */
  @IsArray() @IsOptional() @Type(() => Number) @IsInt({ each: true })
  participatingSiteIds?: number[];
}

/** Same shape, all optional — applied to future occurrences of the series. */
export class UpdateScheduleDto {
  @Type(() => Number) @IsInt() @IsOptional() collectionPointId?: number;
  @IsEnum(ConsolidatedHandoverMethod) @IsOptional() method?: ConsolidatedHandoverMethod;
  @IsEnum(ConsolidatedRecurrence) @IsOptional() recurrence?: ConsolidatedRecurrence;

  @IsDateString() @IsOptional() startDate?: string;
  @IsDateString() @IsOptional() endDate?: string;

  @IsArray() @IsOptional() @Type(() => Number) @IsInt({ each: true }) daysOfWeek?: number[];
  @IsArray() @IsOptional() @IsDateString({}, { each: true }) customDates?: string[];
  @Type(() => Number) @IsInt() @Min(0) @Max(30) @IsOptional() opensDaysBefore?: number;

  @Matches(HHMM, { message: TIME_MESSAGE }) @IsOptional() submissionsCloseTime?: string;
  @Matches(HHMM, { message: TIME_MESSAGE }) @IsOptional() handoverStartTime?: string;
  @Matches(HHMM, { message: TIME_MESSAGE }) @IsOptional() handoverEndTime?: string;
  @Matches(HHMM, { message: TIME_MESSAGE }) @IsOptional() pickupStartTime?: string;
  @Matches(HHMM, { message: TIME_MESSAGE }) @IsOptional() pickupEndTime?: string;

  @IsString() @IsOptional() @MaxLength(120) contactName?: string;
  @IsString() @IsOptional() @MaxLength(30) contactPhone?: string;
  @IsString() @IsOptional() @MaxLength(1000) instructions?: string;
  @IsString() @IsOptional() @MaxLength(1000) suitabilityNotes?: string;

  @IsArray() @IsOptional() @Type(() => Number) @IsInt({ each: true })
  participatingSiteIds?: number[];
}

export class EndScheduleDto {
  /** Collections on or after this local date are cancelled. */
  @IsDateString() fromDate!: string;
}
