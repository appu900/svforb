import { ConsolidatedMemberRole } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  ArrayNotEmpty, IsArray, IsBoolean, IsEnum, IsInt, IsNotEmpty, IsNumber,
  IsOptional, IsString, MaxLength, ValidateNested,
} from 'class-validator';

export class CollectionPointDto {
  @IsString() @IsNotEmpty() @MaxLength(120) name!: string;
  @IsString() @IsNotEmpty() @MaxLength(250) address!: string;
  @IsString() @IsOptional() @MaxLength(20) postcode?: string;

  @Type(() => Number) @IsNumber() lat!: number;
  @Type(() => Number) @IsNumber() lng!: number;

  @IsString() @IsOptional() @MaxLength(500) directions?: string;
}

export class GroupMemberDto {
  @Type(() => Number) @IsInt() userId!: number;
  @IsEnum(ConsolidatedMemberRole) role!: ConsolidatedMemberRole;
}

export class CreateGroupDto {
  @IsString() @IsNotEmpty() @MaxLength(120) name!: string;
  @IsString() @IsOptional() @MaxLength(500) description?: string;

  /** Owns the master listing. Must be one of `siteIds` (SPEC A2). */
  @Type(() => Number) @IsInt() hostSiteId!: number;

  @Type(() => Number) @IsInt({ each: true }) @ArrayNotEmpty() siteIds!: number[];

  /** IANA zone. Defaults to the host site's own timezone. */
  @IsString() @IsOptional() @MaxLength(80) timezone?: string;

  @ValidateNested() @Type(() => CollectionPointDto) collectionPoint!: CollectionPointDto;

  /** The creator is always a manager, whether or not they are listed here. */
  @IsArray() @IsOptional() @ValidateNested({ each: true }) @Type(() => GroupMemberDto)
  members?: GroupMemberDto[];
}

export class UpdateGroupDto {
  @IsString() @IsOptional() @MaxLength(120) name?: string;
  @IsString() @IsOptional() @MaxLength(500) description?: string;
  @Type(() => Number) @IsInt() @IsOptional() hostSiteId?: number;
  @IsString() @IsOptional() @MaxLength(80) timezone?: string;
}

/** The full intended membership — anything left out is removed. */
export class SetGroupSitesDto {
  @Type(() => Number) @IsInt({ each: true }) @ArrayNotEmpty() siteIds!: number[];

  /** Required when the current host site is being removed. */
  @Type(() => Number) @IsInt() @IsOptional() hostSiteId?: number;
}

export class SetGroupMembersDto {
  @IsArray() @ValidateNested({ each: true }) @Type(() => GroupMemberDto)
  members!: GroupMemberDto[];
}

export class UpdateCollectionPointDto {
  @IsString() @IsOptional() @MaxLength(120) name?: string;
  @IsString() @IsOptional() @MaxLength(250) address?: string;
  @IsString() @IsOptional() @MaxLength(20) postcode?: string;
  @Type(() => Number) @IsNumber() @IsOptional() lat?: number;
  @Type(() => Number) @IsNumber() @IsOptional() lng?: number;
  @IsString() @IsOptional() @MaxLength(500) directions?: string;
  @IsBoolean() @IsOptional() isDefault?: boolean;
  @IsBoolean() @IsOptional() isActive?: boolean;
}

export class GroupListQueryDto {
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean() @IsOptional()
  includeArchived?: boolean;

  @IsString() @IsOptional() @MaxLength(120) search?: string;
}

export class DeclineInvitationDto {
  @IsString() @IsOptional() @MaxLength(500) reason?: string;
}
