import {
  Body,
  Controller,
  Get,
  Patch,
  Post,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { AuthService } from './service/auth.service';
import {
  ForgotPasswordDto,
  LoginDto,
  RegisterBusinessDto,
  RegisterCharityDto,
  RegisterPlatformAdminDto,
  ResetPasswordDto,
  VerifyEmailOtpDto,
  UpdateProfileDto,
} from './dto/auth.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { Jwtpayload } from './interface/jwt.interface';
import { Request } from 'express';
import { ResendVerficationOtpDto } from './dto/resend-verification';
import { RegisterFarmerProducerDto } from './dto/register.farmer.producer.dto';
import { RegisterFarmerConsumerDto } from './dto/register.farmer.consumer.dto';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register/business')
  @UseInterceptors(FileInterceptor('logo'))
  registerBusiness(
    @Body() dto: RegisterBusinessDto,
    @UploadedFile() logo?: Express.Multer.File,
  ) {
    return this.authService.registerBusiness(dto, logo);
  }

  @Post('register/charity')
  @UseInterceptors(FileInterceptor('logo'))
  registerCharity(
    @Body() dto: RegisterCharityDto,
    @UploadedFile() logo?: Express.Multer.File,
  ) {
    return this.authService.registerCharity(dto, logo);
  }

  @Post('register/farmer-producer')
  @UseInterceptors(FileInterceptor('logo'))
  registerFarmerProducer(
    @Body() dto: RegisterFarmerProducerDto,
    @UploadedFile() logo?: Express.Multer.File,
  ) {
    return this.authService.registerFarmerProducer(dto, logo);
  }

  @Post('register/farmer-consumer')
  @UseInterceptors(FileInterceptor('logo'))
  registerFarmerConsumer(
    @Body() dto: RegisterFarmerConsumerDto,
    @UploadedFile() logo?: Express.Multer.File,
  ) {
    return this.authService.registerFarmerConsumer(dto, logo);
  }

  @Post('register/platform-admin')
  registerPlatformAdmin(@Body() dto: RegisterPlatformAdminDto) {
    return this.authService.registerPlatformAdmin(dto);
  }

  @Post('login')
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  @Post('verify-email')
  verifyEmail(@Body() dto: VerifyEmailOtpDto) {
    return this.authService.verifyEmail(dto);
  }

  @Get('profile')
  @UseGuards(JwtAuthGuard)
  getProfile(@Req() req: Request & { user: Jwtpayload }) {
    return this.authService.getProfile(req.user.sub);
  }

  @Patch('profile')
  @UseGuards(JwtAuthGuard)
  updateProfile(
    @Req() req: Request & { user: Jwtpayload },
    @Body() dto: UpdateProfileDto,
  ) {
    return this.authService.updateProfile(req.user.sub, dto.phoneNumber);
  }

  @Post('forgot-password')
  forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.authService.forgotPassword(dto);
  }

  @Post('reset-password')
  resetPassword(@Body() dto: ResetPasswordDto) {
    return this.authService.resetPassword(dto);
  }

  @Post('/resend-verification')
  sendVerificationOtp(@Body() dto: ResendVerficationOtpDto) {
    return this.authService.resendVerificationEmail(dto.email);
  }
}
