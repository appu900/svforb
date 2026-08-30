import {
  BillingFrequency,
  ContractStatus,
  EnterpriseAccountStatus,
  EnterpriseRole,
  MeasurementUnit,
  Region,
  ScopeType,
} from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  ArrayNotEmpty,
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

/**
 * Group, Cluster and Territory are independent dimensions and are created the
 * same way — a cluster deliberately takes no group, because it does not sit
 * inside one.
 *
 * None of these carry `isActive`: activation moves through the explicit
 * deactivate and reactivate endpoints, so there is exactly one path to it and
 * one audit record for it.
 */
class StructureBaseDto {
  @IsString() @IsNotEmpty() @MaxLength(120) name!: string;
  @IsString() @IsOptional() @MaxLength(40) code?: string;
  @IsString() @IsOptional() @MaxLength(500) description?: string;
}

class StructureUpdateBaseDto {
  @IsString() @IsOptional() @MaxLength(120) name?: string;
  @IsString() @IsOptional() @MaxLength(40) code?: string;
  @IsString() @IsOptional() @MaxLength(500) description?: string;
}

export class CreateGroupDto extends StructureBaseDto {}
export class UpdateGroupDto extends StructureUpdateBaseDto {}

export class CreateClusterDto extends StructureBaseDto {}
export class UpdateClusterDto extends StructureUpdateBaseDto {}

export class CreateTerritoryDto extends StructureBaseDto {}
export class UpdateTerritoryDto extends StructureUpdateBaseDto {}

/** Deactivated structures are hidden unless explicitly asked for. */
export class StructureListQueryDto {
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  @IsOptional()
  includeInactive?: boolean;
  @IsString() @IsOptional() @MaxLength(120) search?: string;
}

export class AssignSitesDto {
  @Type(() => Number)
  @IsInt({ each: true })
  @ArrayNotEmpty()
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

export const USER_STATUS = {
  INVITED: 'INVITED',
  ACTIVE: 'ACTIVE',
  DEACTIVATED: 'DEACTIVATED',
} as const;

export type UserStatusFilter = (typeof USER_STATUS)[keyof typeof USER_STATUS];

/**
 * Users & Access listing. Invited people appear alongside members, so the
 * status filter spans both — someone who has been invited but not activated is
 * still a row on this screen.
 */
export class UserListQueryDto {
  @Type(() => Number) @IsInt() @IsOptional() page?: number;
  @Type(() => Number) @IsInt() @IsOptional() pageSize?: number;

  @IsString() @IsOptional() @MaxLength(160) search?: string;
  @IsEnum(EnterpriseRole) @IsOptional() role?: EnterpriseRole;

  @IsEnum(USER_STATUS) @IsOptional() status?: UserStatusFilter;

  /** Narrow the listing to people whose reach includes this structure. */
  @IsEnum(ScopeType) @IsOptional() scopeType?: ScopeType;
  @Type(() => Number) @IsInt() @IsOptional() scopeId?: number;
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
