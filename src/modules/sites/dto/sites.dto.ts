import {
  IsEmail,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
} from 'class-validator';
import { Type } from 'class-transformer';

export class CreateSiteDto {
  @IsString() @IsNotEmpty() siteName!: string;
  @IsString() @IsNotEmpty() address!: string;
  @IsString() @IsNotEmpty() postcode!: string;
  @IsString() @IsNotEmpty() contactName!: string;
  @IsEmail() contactEmail!: string;
  @IsString() @IsOptional() phoneNumber?: string;

  @IsNotEmpty()
  @Type(() => Number)
  @IsNumber()
  latitude!: number;

  @IsNotEmpty()
  @Type(() => Number)
  @IsNumber()
  longitude!: number;
}

export class AssignSiteManagerDto {
  @IsInt()
  @Type(() => Number)
  userId!: number;
}

export class AddStaffDto {
  @IsInt()
  @Type(() => Number)
  userId!: number;
}
