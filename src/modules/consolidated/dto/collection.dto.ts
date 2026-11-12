import { Type } from 'class-transformer';
import {
  IsArray, IsDateString, IsIn, IsInt, IsNotEmpty, IsOptional, IsString, Matches, Max, MaxLength, Min,
} from 'class-validator';

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const TIME_MESSAGE = 'Use a 24-hour time such as 14:30.';

export class ReopenSubmissionsDto {
  /** Must not be after the end of handover — food has to be in the room. */
  @IsDateString() until!: string;
}

export class CancelCollectionDto {
  @IsString() @IsNotEmpty() @MaxLength(500) reason!: string;
}

export class RemindSitesDto {
  /** Omit to remind every site that has not contributed. */
  @IsArray() @IsOptional() @Type(() => Number) @IsInt({ each: true })
  siteIds?: number[];
}

/**
 * Edits one occurrence, detaching it from its series so later series edits
 * leave it alone.
 */
export class UpdateCollectionDto {
  @Type(() => Number) @IsInt() @IsOptional() collectionPointId?: number;

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

/** `GET /consolidated/collections` — the manager/receiver list (SPEC §7.3). */
export class CollectionListQueryDto {
  @IsIn(['upcoming', 'active', 'past']) @IsOptional() tab?: 'upcoming' | 'active' | 'past';
  @Type(() => Number) @IsInt() @IsOptional() groupId?: number;
  @Type(() => Number) @IsInt() @Min(1) @IsOptional() page?: number;
  @Type(() => Number) @IsInt() @Min(1) @Max(100) @IsOptional() limit?: number;
}
