import {
  IsBoolean,
  IsEmail,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  MinLength,
} from 'class-validator';

export enum FarmerConsumerMemberRole {
  ADMIN = 'ADMIN',
  TEAM_MEMBER = 'TEAM_MEMBER',
  DRIVER = 'DRIVER',
}

export class AddFarmerConsumerMemberDto {
  @IsString() @IsNotEmpty() firstName!: string;
  @IsString() @IsNotEmpty() lastName!: string;
  @IsEmail() email!: string;
  @IsString() @IsOptional() mobile?: string;
  @IsEnum(FarmerConsumerMemberRole) role!: FarmerConsumerMemberRole;
  @IsString() @MinLength(8) password!: string;
  @IsBoolean() @IsOptional() canClaimPickupsDirectly?: boolean;
}

export class UpdateFarmerConsumerMemberDto {
  @IsString() @IsOptional() firstName?: string;
  @IsString() @IsOptional() lastName?: string;
  @IsString() @IsOptional() mobile?: string;
  @IsBoolean() @IsOptional() canClaimPickupsDirectly?: boolean;
}

export class ResendFarmerConsumerInviteDto {
  @IsString() @MinLength(8) newPassword!: string;
}
