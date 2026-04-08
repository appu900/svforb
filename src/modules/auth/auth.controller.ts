import {
  Body,
  Controller,
  Get,
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
} from './dto/auth.dto';
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard';
import { Jwtpayload } from './interface/jwt.interface';
import { Request } from 'express';

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

  @Post('forgot-password')
  forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.authService.forgotPassword(dto);
  }

  @Post('reset-password')
  resetPassword(@Body() dto: ResetPasswordDto) {
    return this.authService.resetPassword(dto);
  }
}
