import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { OrgRole } from '@prisma/client';
import { Jwtpayload } from 'src/modules/auth/interface/jwt.interface';

@Injectable()
export class SuperAdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{ user: Jwtpayload }>();
    const user = request.user;

    if (user?.orgRole !== OrgRole.SUPER_ADMIN) {
      throw new ForbiddenException('Only organisation super admins can perform this action');
    }
    return true;
  }
}
