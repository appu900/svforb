import {
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
} from 'class-validator';

export class RegisterTokenDto {
  @IsString()
  @IsNotEmpty()
  token!: string;

  @IsString()
  @IsEnum(['ios', 'android'])
  platform!: 'ios' | 'android';

  @IsString()
  @IsEnum(['apns', 'fcm', 'expo'])
  tokenType!: 'apns' | 'fcm' | 'expo';

  @IsOptional()
  @IsString()
  @IsEnum(['prod', 'dev'])
  tokenMode?: 'prod' | 'dev';

  @IsOptional()
  @IsString()
  appVersion?: string;

  @IsOptional()
  @IsString()
  appBuild?: string;

  @IsOptional()
  @IsString()
  appBundle?: string;

  /** Which mobile app this token belongs to. Required for the driver app. */
  @IsOptional()
  @IsEnum(['business', 'driver'])
  targetApp?: 'business' | 'driver';
}

export class UnregisterTokenDto {
  @IsString()
  @IsNotEmpty()
  token!: string;
}
