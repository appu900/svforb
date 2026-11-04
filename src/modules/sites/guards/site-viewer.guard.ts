import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { OrgRole, SiteRole } from '@prisma/client';
import { Jwtpayload } from '../../../modules/auth/interface/jwt.interface';

/**
 * Read-only site routes. Adds every Enterprise role on top of
 * SiteAdminOrAboveGuard; the service layer limits site-scoped roles
 * to the sites they are assigned.
 */
@Injectable()
export class SiteViewerGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const user = context.switchToHttp().getRequest<{ user: Jwtpayload }>().user;

    const allowed =
      user?.orgRole === OrgRole.SUPER_ADMIN ||
      user?.siteRole === SiteRole.SITE_ADMIN ||
      Boolean(user?.enterpriseRole);

    if (!allowed) {
      throw new ForbiddenException('Site admin or super admin access required');
    }
    return true;
  }
}
