import { OrgType } from '@prisma/client';
import {
  IsArray,
  IsBoolean,
  IsEnum,
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
  @IsString() @IsOptional() description?: string;

  /** Omit for unlimited (Enterprise). */
  @IsInt() @Min(1) @IsOptional() maxSites?: number;
  /** Omit for unlimited (Multi Site, Enterprise). */
  @IsInt() @Min(1) @IsOptional() maxUserPerSite?: number;

  /** Omit when the plan is quote-based — see contactSalesOnly. */
  @IsNumber() @Min(0) @IsOptional() priceMonthly?: number;
  @IsNumber() @Min(0) @IsOptional() priceAnnual?: number;

  /** India (region = IN) pricing. */
  @IsNumber() @Min(0) @IsOptional() priceMonthlyInr?: number;
  @IsNumber() @Min(0) @IsOptional() priceAnnualInr?: number;

  /** Bills per location; the Stripe quantity tracks site count. */
  @IsBoolean() @IsOptional() isPerSite?: boolean;

  /** Excluded from Checkout; the client routes to an enquiry form. */
  @IsBoolean() @IsOptional() contactSalesOnly?: boolean;

  @IsArray() @IsEnum(OrgType, { each: true }) @IsOptional()
  applicableOrgTypes?: OrgType[];

  @IsArray() @IsString({ each: true }) features!: string[];

  @IsBoolean() @IsOptional() isMostPopular?: boolean;
  @IsInt() @IsOptional() sortOrder?: number;
}

export class UpdateSubscriptionPlanDto {
  @IsString() @IsNotEmpty() @IsOptional() displayName?: string;
  @IsString() @IsOptional() description?: string;

  @IsInt() @Min(1) @IsOptional() maxSites?: number;
  @IsInt() @Min(1) @IsOptional() maxUserPerSite?: number;

  @IsNumber() @Min(0) @IsOptional() priceMonthly?: number;
  @IsNumber() @Min(0) @IsOptional() priceAnnual?: number;
  @IsNumber() @Min(0) @IsOptional() priceMonthlyInr?: number;
  @IsNumber() @Min(0) @IsOptional() priceAnnualInr?: number;

  @IsBoolean() @IsOptional() isPerSite?: boolean;
  @IsBoolean() @IsOptional() contactSalesOnly?: boolean;

  @IsArray() @IsEnum(OrgType, { each: true }) @IsOptional()
  applicableOrgTypes?: OrgType[];

  @IsArray() @IsString({ each: true }) @IsOptional() features?: string[];

  @IsBoolean() @IsOptional() isMostPopular?: boolean;
  @IsInt() @IsOptional() sortOrder?: number;
  @IsBoolean() @IsOptional() isActive?: boolean;
}
