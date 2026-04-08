import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { OrgRole, SiteRole } from '@prisma/client';
import { Jwtpayload } from 'src/modules/auth/interface/jwt.interface';

/**
 * Allows SUPER_ADMIN (org level) OR SITE_ADMIN (site level).
 * Fine-grained site ownership checks (e.g. "is this admin for THIS site?")
 * are enforced in the service layer.
 */
@Injectable()
export class SiteAdminOrAboveGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{ user: Jwtpayload }>();
    const user = request.user;

    const isSuperAdmin = user?.orgRole === OrgRole.SUPER_ADMIN;
    const isSiteAdmin = user?.siteRole === SiteRole.SITE_ADMIN;

    if (!isSuperAdmin && !isSiteAdmin) {
      throw new ForbiddenException('Site admin or super admin access required');
    }
    return true;
  }
}
