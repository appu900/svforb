import { BillingCycle, EnterpriseContactWindow, EnterpriseLocationBand } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export class StartTrialDto {
  @Type(() => Number)
  @IsInt()
  planId!: number;

  /** Which cycle to charge once the trial converts. Defaults to monthly. */
  @IsOptional()
  @IsEnum(BillingCycle)
  billingCycle?: BillingCycle;
}

export class CreateCheckoutSessionDto {
  @Type(() => Number)
  @IsInt()
  planId!: number;

  @IsEnum(BillingCycle)
  billingCycle!: BillingCycle;
}

export class ChangePlanDto {
  @Type(() => Number)
  @IsInt()
  planId!: number;

  /** Omit to keep the current cycle. */
  @IsOptional()
  @IsEnum(BillingCycle)
  billingCycle?: BillingCycle;
}

export class EnterpriseEnquiryDto {
  @IsString() @IsNotEmpty() firstName!: string;
  @IsString() @IsNotEmpty() lastName!: string;
  @IsString() @IsNotEmpty() businessName!: string;
  @IsString() @IsNotEmpty() businessType!: string;
  @IsString() @IsNotEmpty() mobile!: string;

  @IsEnum(EnterpriseLocationBand)
  locationBand!: EnterpriseLocationBand;

  @IsEnum(EnterpriseContactWindow)
  contactWindow!: EnterpriseContactWindow;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  message?: string;
}
