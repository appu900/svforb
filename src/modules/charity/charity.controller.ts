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
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard';
import { Jwtpayload } from '../auth/interface/jwt.interface';
import {
  AddCharityLocationDto,
  AddCharityMemberDto,
  ResendInviteDto,
  UpdateCharityLocationDto,
  UpdateCharityMemberDto,
} from './dto/charity.dto';
import { CharityService } from './service/charity.service';

@Controller('charity')
@UseGuards(JwtAuthGuard)
export class CharityController {
  constructor(private readonly charityService: CharityService) {}

  

  @Post('locations')
  addLocation(
    @Req() req: Request & { user: Jwtpayload },
    @Body() dto: AddCharityLocationDto,
  ) {
    return this.charityService.addLocation(req.user, dto);
  }
  
   

  @Get('locations')
  listLocations(@Req() req: Request & { user: Jwtpayload }) {
    return this.charityService.listLocations(req.user);
  }

  @Get('locations/:id')
  getLocation(
    @Req() req: Request & { user: Jwtpayload },
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.charityService.getLocation(req.user, id);
  }

  @Patch('locations/:id')
  updateLocation(
    @Req() req: Request & { user: Jwtpayload },
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateCharityLocationDto,
  ) {
    return this.charityService.updateLocation(req.user, id, dto);
  }

  @Delete('locations/:id')
  deactivateLocation(
    @Req() req: Request & { user: Jwtpayload },
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.charityService.deactivateLocation(req.user, id);
  }

  

  @Post('users')
  addMember(
    @Req() req: Request & { user: Jwtpayload },
    @Body() dto: AddCharityMemberDto,
  ) {
    return this.charityService.addMember(req.user, dto);
  }

  @Get('users')
  listUsers(@Req() req: Request & { user: Jwtpayload }) {
    return this.charityService.listUsers(req.user);
  }

  @Get('users/:userId')
  getUser(
    @Req() req: Request & { user: Jwtpayload },
    @Param('userId', ParseIntPipe) userId: number,
  ) {
    return this.charityService.getUser(req.user, userId);
  }

  @Patch('users/:userId')
  updateUser(
    @Req() req: Request & { user: Jwtpayload },
    @Param('userId', ParseIntPipe) userId: number,
    @Body() dto: UpdateCharityMemberDto,
  ) {
    return this.charityService.updateUser(req.user, userId, dto);
  }

  @Post('users/:userId/deactivate')
  deactivateUser(
    @Req() req: Request & { user: Jwtpayload },
    @Param('userId', ParseIntPipe) userId: number,
  ) {
    return this.charityService.deactivateUser(req.user, userId);
  }

  @Post('users/:userId/activate')
  activateUser(
    @Req() req: Request & { user: Jwtpayload },
    @Param('userId', ParseIntPipe) userId: number,
  ) {
    return this.charityService.activateUser(req.user, userId);
  }

  @Delete('users/:userId')
  deleteUser(
    @Req() req: Request & { user: Jwtpayload },
    @Param('userId', ParseIntPipe) userId: number,
  ) {
    return this.charityService.deleteUser(req.user, userId);
  }

  @Post('users/:userId/resend-invite')
  resendInvite(
    @Req() req: Request & { user: Jwtpayload },
    @Param('userId', ParseIntPipe) userId: number,
    @Body() dto: ResendInviteDto,
  ) {
    return this.charityService.resendInvite(req.user, userId, dto.newPassword);
  }
}
