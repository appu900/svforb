import {
  BillingFrequency,
  ContractStatus,
  EnterpriseAccountStatus,
  EnterpriseRole,
  MeasurementUnit,
  Region,
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

// ─── Provisioning & profile ──────────────────────────────────────────────────

/**
 * Saveful creates the Enterprise; customers cannot self-create one. Everything
 * here is set in the Saveful administration environment.
 */
export class ProvisionEnterpriseDto {
  @IsString() @IsNotEmpty() @MaxLength(160) enterpriseName!: string;
  /// Human-facing identifier, e.g. ENT-AU-001284. Generated when omitted.
  @IsString() @IsOptional() @MaxLength(40) enterpriseId?: string;

  @IsString() @IsNotEmpty() @MaxLength(200) address!: string;
  @IsString() @IsNotEmpty() @MaxLength(80) country!: string;
  @IsString() @IsNotEmpty() @MaxLength(80) timezone!: string;
  @IsString() @IsOptional() @MaxLength(3) currency?: string;
  @IsEnum(MeasurementUnit) @IsOptional() measurementUnit?: MeasurementUnit;
  @IsEnum(Region) @IsOptional() region?: Region;

  @IsString() @IsOptional() @MaxLength(500) logoUrl?: string;

  /// The nominated Enterprise Super Admin. They receive an activation
  /// invitation — no password is set on their behalf.
  @IsString() @IsNotEmpty() @MaxLength(80) adminFirstName!: string;
  @IsString() @IsNotEmpty() @MaxLength(80) adminLastName!: string;
  @IsEmail() adminEmail!: string;
  @IsString() @IsOptional() @MaxLength(30) adminMobile?: string;
}

/** Provisioning fields, editable by Saveful only. */
export class UpdateProvisioningDto {
  @IsEnum(EnterpriseAccountStatus) @IsOptional() accountStatus?: EnterpriseAccountStatus;
  @IsString() @IsOptional() @MaxLength(80) country?: string;
  @IsString() @IsOptional() @MaxLength(80) timezone?: string;
  @IsString() @IsOptional() @MaxLength(3) currency?: string;
  @IsEnum(MeasurementUnit) @IsOptional() measurementUnit?: MeasurementUnit;
}

/** Organisation Profile fields an authorised Enterprise user may maintain. */
export class UpdateEnterpriseProfileDto {
  @IsString() @IsOptional() @MaxLength(160) enterpriseName?: string;
  @IsString() @IsOptional() @MaxLength(120) primaryContactName?: string;
  @IsEmail() @IsOptional() primaryContactEmail?: string;
  @IsString() @IsOptional() @MaxLength(30) primaryContactPhone?: string;
  @IsString() @IsOptional() @MaxLength(500) logoUrl?: string;
  @IsString() @IsOptional() @MaxLength(80) timezone?: string;
  @IsEnum(MeasurementUnit) @IsOptional() measurementUnit?: MeasurementUnit;
}

// ─── Invitations ─────────────────────────────────────────────────────────────

/** Invite a user. No password field by design — they create their own. */
export class InviteUserDto {
  @IsString() @IsNotEmpty() @MaxLength(80) firstName!: string;
  @IsString() @IsNotEmpty() @MaxLength(80) lastName!: string;
  @IsEmail() email!: string;
  @IsString() @IsOptional() @MaxLength(30) mobile?: string;

  @IsEnum(EnterpriseRole) role!: EnterpriseRole;

  @IsArray() @IsOptional() @ValidateNested({ each: true }) @Type(() => ScopeGrantDto)
  scopes?: ScopeGrantDto[];

  @Type(() => Number) @IsInt() @IsOptional() siteAdminForSiteId?: number;
}

export class AcceptInvitationDto {
  @IsString() @MinLength(10) @MaxLength(128) password!: string;
  @IsBoolean() acceptTerms!: boolean;
}
