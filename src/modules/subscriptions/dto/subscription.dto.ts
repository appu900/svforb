import {
  IsArray,
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';

export class CreateSubscriptionPlanDto {
  @IsString() @IsNotEmpty() name!: string;
  @IsString() @IsNotEmpty() displayName!: string;

  @IsInt() @Min(1) maxSites!: number;
  @IsInt() @Min(1) maxUserPerSite!: number;

  @IsNumber() @Min(0) priceMonthly!: number;
  @IsNumber() @Min(0) priceAnnual!: number;

  @IsArray() @IsString({ each: true }) features!: string[];
}

export class UpdateSubscriptionPlanDto {
  @IsString() @IsNotEmpty() @IsOptional() displayName?: string;
  @IsInt() @Min(1) @IsOptional() maxSites?: number;
  @IsInt() @Min(1) @IsOptional() maxUserPerSite?: number;
  @IsNumber() @Min(0) @IsOptional() priceMonthly?: number;
  @IsNumber() @Min(0) @IsOptional() priceAnnual?: number;
  @IsArray() @IsString({ each: true }) @IsOptional() features?: string[];
  @IsBoolean() @IsOptional() isActive?: boolean;
}
