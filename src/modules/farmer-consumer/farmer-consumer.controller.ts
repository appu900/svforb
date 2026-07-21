import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { Jwtpayload } from '../auth/interface/jwt.interface';
import {
  AddFarmerConsumerMemberDto,
  ResendFarmerConsumerInviteDto,
  UpdateFarmerConsumerMemberDto,
} from './dto/farmer-consumer.dto';
import { FarmerConsumerService } from './service/farmer-consumer.service';

@Controller('farmer-consumer')
@UseGuards(JwtAuthGuard)
export class FarmerConsumerController {
  constructor(private readonly service: FarmerConsumerService) {}

  @Post('users')
  addMember(
    @Req() req: Request & { user: Jwtpayload },
    @Body() dto: AddFarmerConsumerMemberDto,
  ) {
    return this.service.addMember(req.user, dto);
  }

  @Get('users')
  listUsers(@Req() req: Request & { user: Jwtpayload }) {
    return this.service.listUsers(req.user);
  }

  @Get('users/:userId')
  getUser(
    @Req() req: Request & { user: Jwtpayload },
    @Param('userId', ParseIntPipe) userId: number,
  ) {
    return this.service.getUser(req.user, userId);
  }

  @Patch('users/:userId')
  updateUser(
    @Req() req: Request & { user: Jwtpayload },
    @Param('userId', ParseIntPipe) userId: number,
    @Body() dto: UpdateFarmerConsumerMemberDto,
  ) {
    return this.service.updateUser(req.user, userId, dto);
  }

  @Post('users/:userId/deactivate')
  deactivateUser(
    @Req() req: Request & { user: Jwtpayload },
    @Param('userId', ParseIntPipe) userId: number,
  ) {
    return this.service.deactivateUser(req.user, userId);
  }

  @Post('users/:userId/activate')
  activateUser(
    @Req() req: Request & { user: Jwtpayload },
    @Param('userId', ParseIntPipe) userId: number,
  ) {
    return this.service.activateUser(req.user, userId);
  }

  @Delete('users/:userId')
  deleteUser(
    @Req() req: Request & { user: Jwtpayload },
    @Param('userId', ParseIntPipe) userId: number,
  ) {
    return this.service.deleteUser(req.user, userId);
  }

  @Post('users/:userId/resend-invite')
  resendInvite(
    @Req() req: Request & { user: Jwtpayload },
    @Param('userId', ParseIntPipe) userId: number,
    @Body() dto: ResendFarmerConsumerInviteDto,
  ) {
    return this.service.resendInvite(req.user, userId, dto.newPassword);
  }
}
