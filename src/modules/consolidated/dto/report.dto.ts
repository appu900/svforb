import { Type } from 'class-transformer';
import { IsDateString, IsInt, IsOptional } from 'class-validator';

export class ConsolidatedReportQueryDto {
  @IsDateString() @IsOptional() from?: string;
  @IsDateString() @IsOptional() to?: string;

  @Type(() => Number) @IsInt() @IsOptional() groupId?: number;
  /** A site user may pass only their own site. */
  @Type(() => Number) @IsInt() @IsOptional() siteId?: number;

  @Type(() => Number) @IsInt() @IsOptional() page?: number;
  @Type(() => Number) @IsInt() @IsOptional() pageSize?: number;
}
