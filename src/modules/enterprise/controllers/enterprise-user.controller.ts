import {
  Body, Controller, Get, Param, ParseIntPipe, Patch, Post, Put, Req, UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { Jwtpayload } from '../../auth/interface/jwt.interface';
import {
  InviteEnterpriseUserDto, ResendInviteDto, SetUserScopesDto, UpdateEnterpriseUserDto,
} from '../dto/enterprise.dto';
import { EnterpriseUserService } from '../services/enterprise-user.service';

/**
 * Role decides what a user can do; scope decides which slice of the Enterprise
 * they can see. The two are set independently.
 */
@Controller('enterprise/users')
@UseGuards(JwtAuthGuard)
export class EnterpriseUserController {
  constructor(private readonly users: EnterpriseUserService) {}

  @Post()
  invite(@Req() req: Request & { user: Jwtpayload }, @Body() dto: InviteEnterpriseUserDto) {
    return this.users.inviteUser(req.user, dto);
  }

  /** Everyone in the Enterprise, with role, status and scope grants. */
  @Get()
  list(@Req() req: Request & { user: Jwtpayload }) {
    return this.users.listUsers(req.user);
  }

  @Get(':userId')
  get(
    @Req() req: Request & { user: Jwtpayload },
    @Param('userId', ParseIntPipe) userId: number,
  ) {
    return this.users.getUser(req.user, userId);
  }

  @Patch(':userId')
  update(
    @Req() req: Request & { user: Jwtpayload },
    @Param('userId', ParseIntPipe) userId: number,
    @Body() dto: UpdateEnterpriseUserDto,
  ) {
    return this.users.updateUser(req.user, userId, dto);
  }

  /** Replaces the user's scope grants wholesale. */
  @Put(':userId/scopes')
  setScopes(
    @Req() req: Request & { user: Jwtpayload },
    @Param('userId', ParseIntPipe) userId: number,
    @Body() dto: SetUserScopesDto,
  ) {
    return this.users.setScopes(req.user, userId, dto);
  }

  @Post(':userId/activate')
  activate(
    @Req() req: Request & { user: Jwtpayload },
    @Param('userId', ParseIntPipe) userId: number,
  ) {
    return this.users.setActive(req.user, userId, true);
  }

  @Post(':userId/deactivate')
  deactivate(
    @Req() req: Request & { user: Jwtpayload },
    @Param('userId', ParseIntPipe) userId: number,
  ) {
    return this.users.setActive(req.user, userId, false);
  }

  @Post(':userId/resend-invite')
  resendInvite(
    @Req() req: Request & { user: Jwtpayload },
    @Param('userId', ParseIntPipe) userId: number,
    @Body() dto: ResendInviteDto,
  ) {
    return this.users.resendInvite(req.user, userId, dto);
  }
}
