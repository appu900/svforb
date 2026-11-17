import { FoodSource } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsDateString, IsEnum, IsInt, IsOptional } from 'class-validator';

export class MfcInsightsQueryDto {
  @IsDateString() from!: string;
  @IsDateString() to!: string;

  @Type(() => Number) @IsInt() @IsOptional() groupId?: number;
  @Type(() => Number) @IsInt() @IsOptional() territoryId?: number;
  @Type(() => Number) @IsInt() @IsOptional() clusterId?: number;
  @Type(() => Number) @IsInt() @IsOptional() siteId?: number;
}

export class MfcSourceParamDto {
  @IsEnum(FoodSource) source!: FoodSource;
}

export class MfcHomeImpactQueryDto {
  @Type(() => Number) @IsInt() @IsOptional() siteId?: number;
}
