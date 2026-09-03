import {
  Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Put, Query, Req, UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { Jwtpayload } from '../../auth/interface/jwt.interface';
import { SkipSubscriptionCheck } from '../../subscriptions/decorators/skip-subscription-check.decorator';
import {
  InviteUserDto, SetUserScopesDto, UpdateEnterpriseUserDto, UserListQueryDto,
} from '../dto/enterprise.dto';
import { EnterpriseUserService } from '../services/enterprise-user.service';
import { ApiBearerAuth } from '@nestjs/swagger';

/**
 * Role decides what a user can do; scope decides which slice of the Enterprise
 * they can see. The two are set independently.
 */
@Controller('enterprise/users')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth('bearer')
export class EnterpriseUserController {
  constructor(private readonly users: EnterpriseUserService) {}

  @Post()
  invite(@Req() req: Request & { user: Jwtpayload }, @Body() dto: InviteUserDto) {
    return this.users.inviteUser(req.user, dto);
  }

  /**
   * Everyone in the Enterprise — members and people still on an invitation —
   * with role, status and scope grants. Paginated, filterable by role, status,
   * free-text search, and by which structure a person can reach.
   */
  @Get()
  list(
    @Req() req: Request & { user: Jwtpayload },
    @Query() query: UserListQueryDto,
  ) {
    return this.users.listUsers(req.user, query);
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

  /** Reissues an activation link for a member. No password is ever set here. */
  @Post(':userId/resend-invite')
  resendInvite(
    @Req() req: Request & { user: Jwtpayload },
    @Param('userId', ParseIntPipe) userId: number,
  ) {
    return this.users.resendInviteForUser(req.user, userId);
  }
}

/**
 * Pending invitations — people who have been invited but have not activated.
 * They have no user record yet, so they cannot live under /enterprise/users.
 */
@Controller('enterprise/invites')
@UseGuards(JwtAuthGuard)
@SkipSubscriptionCheck()
@ApiBearerAuth('bearer')
export class EnterpriseInviteController {
  constructor(private readonly users: EnterpriseUserService) {}

  @Get()
  list(@Req() req: Request & { user: Jwtpayload }) {
    return this.users.listInvitations(req.user);
  }

  @Post(':invitationId/resend')
  resend(
    @Req() req: Request & { user: Jwtpayload },
    @Param('invitationId', ParseIntPipe) invitationId: number,
  ) {
    return this.users.resendInvitation(req.user, invitationId);
  }

  @Delete(':invitationId')
  revoke(
    @Req() req: Request & { user: Jwtpayload },
    @Param('invitationId', ParseIntPipe) invitationId: number,
  ) {
    return this.users.revokeInvitation(req.user, invitationId);
  }
}

/**
 * Roles & Permissions.
 *
 * Served from the same matrix that gates every request, so this screen is a
 * readout of the live rules rather than a description maintained beside them.
 */
@Controller('enterprise/roles')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth('bearer')
export class EnterpriseRolesController {
  constructor(private readonly users: EnterpriseUserService) {}

  @Get()
  list(@Req() req: Request & { user: Jwtpayload }) {
    return this.users.listRoles(req.user);
  }
}
