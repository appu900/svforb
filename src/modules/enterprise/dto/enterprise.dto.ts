import {
  BillingFrequency,
  ContractStatus,
  EnterpriseRole,
  ScopeType,
} from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsEmail,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

// ─── Structure ───────────────────────────────────────────────────────────────

export class CreateGroupDto {
  @IsString() @IsNotEmpty() @MaxLength(120) name!: string;
  @IsString() @IsOptional() @MaxLength(40) code?: string;
}

export class UpdateGroupDto {
  @IsString() @IsOptional() @MaxLength(120) name?: string;
  @IsString() @IsOptional() @MaxLength(40) code?: string;
  @IsBoolean() @IsOptional() isActive?: boolean;
}

export class CreateClusterDto {
  @Type(() => Number) @IsInt() groupId!: number;
  @IsString() @IsNotEmpty() @MaxLength(120) name!: string;
  @IsString() @IsOptional() @MaxLength(40) code?: string;
}

export class UpdateClusterDto {
  @Type(() => Number) @IsInt() @IsOptional() groupId?: number;
  @IsString() @IsOptional() @MaxLength(120) name?: string;
  @IsString() @IsOptional() @MaxLength(40) code?: string;
  @IsBoolean() @IsOptional() isActive?: boolean;
}

export class CreateTerritoryDto {
  @IsString() @IsNotEmpty() @MaxLength(120) name!: string;
  @IsString() @IsOptional() @MaxLength(40) code?: string;
}

export class UpdateTerritoryDto {
  @IsString() @IsOptional() @MaxLength(120) name?: string;
  @IsString() @IsOptional() @MaxLength(40) code?: string;
  @IsBoolean() @IsOptional() isActive?: boolean;
}

export class AssignSitesDto {
  @Type(() => Number)
  @IsInt({ each: true })
  siteIds!: number[];
}

// ─── Contracts & invoices ────────────────────────────────────────────────────

export class CreateContractDto {
  @Type(() => Number) @IsInt() organisationId!: number;

  /** Major units, e.g. 100 for $100.00 per site. */
  @Type(() => Number) @IsNumber() @Min(0) ratePerSite!: number;

  @IsString() @IsOptional() @MaxLength(3) currency?: string;
  @IsEnum(BillingFrequency) @IsOptional() billingFrequency?: BillingFrequency;

  @Type(() => Number) @IsInt() @IsOptional() contractedSiteCount?: number;
  @Type(() => Number) @IsNumber() @Min(0) @IsOptional() taxRatePercent?: number;

  @IsDateString() startDate!: string;
  @IsDateString() @IsOptional() endDate?: string;

  @Type(() => Number) @IsInt() @Min(0) @IsOptional() paymentTermsDays?: number;
  @IsString() @IsOptional() @MaxLength(2000) notes?: string;
}

export class UpdateContractDto {
  @Type(() => Number) @IsNumber() @Min(0) @IsOptional() ratePerSite?: number;
  @IsEnum(BillingFrequency) @IsOptional() billingFrequency?: BillingFrequency;
  @Type(() => Number) @IsInt() @IsOptional() contractedSiteCount?: number;
  @Type(() => Number) @IsNumber() @Min(0) @IsOptional() taxRatePercent?: number;
  @IsDateString() @IsOptional() endDate?: string;
  @IsEnum(ContractStatus) @IsOptional() status?: ContractStatus;
  @Type(() => Number) @IsInt() @Min(0) @IsOptional() paymentTermsDays?: number;
  @IsString() @IsOptional() @MaxLength(2000) notes?: string;
}

export class MarkInvoicePaidDto {
  @IsString() @IsNotEmpty() @MaxLength(120) paymentReference!: string;
  @IsDateString() @IsOptional() paidAt?: string;
  @IsString() @IsOptional() @MaxLength(2000) notes?: string;
}

export class GenerateInvoiceDto {
  @Type(() => Number) @IsInt() organisationId!: number;
  /** Override the period start; defaults to the contract's next anchor. */
  @IsDateString() @IsOptional() periodStart?: string;
}

// ─── User management ─────────────────────────────────────────────────────────


export class ScopeGrantDto {
  @IsEnum(ScopeType) scopeType!: ScopeType;

  /** Omit for ENTERPRISE scope — it covers the whole organisation. */
  @Type(() => Number) @IsInt() @IsOptional() scopeId?: number;
}

export class InviteEnterpriseUserDto {
  @IsString() @IsNotEmpty() firstName!: string;
  @IsString() @IsNotEmpty() lastName!: string;
  @IsEmail() email!: string;
  @IsString() @IsOptional() mobile?: string;
  @IsString() @MinLength(8) password!: string;

  @IsEnum(EnterpriseRole) role!: EnterpriseRole;

  /** Omit for a SUPER_ADMIN, who always covers the whole Enterprise. */
  @IsArray()
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => ScopeGrantDto)
  scopes?: ScopeGrantDto[];
}

export class UpdateEnterpriseUserDto {
  @IsString() @IsOptional() firstName?: string;
  @IsString() @IsOptional() lastName?: string;
  @IsString() @IsOptional() mobile?: string;
  @IsEnum(EnterpriseRole) @IsOptional() role?: EnterpriseRole;
}

export class SetUserScopesDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ScopeGrantDto)
  scopes!: ScopeGrantDto[];
}

export class ResendInviteDto {
  @IsString() @MinLength(8) newPassword!: string;
}
