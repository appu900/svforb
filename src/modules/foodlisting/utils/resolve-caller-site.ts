import { OrgRole } from '@prisma/client';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { Jwtpayload } from '../../auth/interface/jwt.interface';

/**
 * Nearby / inbox need a siteId. Multi HQ tokens are sometimes minted without
 * siteId even when the user has siteAccess (or is SUPER_ADMIN of an org that
 * already has a default HQ site). Resolve from DB so Available Food works.
 */
export async function resolveCallerSiteId(
  prisma: PrismaService,
  caller: Jwtpayload,
): Promise<number | null> {
  if (caller.siteId) return caller.siteId;
  if (!caller.orgId || !caller.sub) return null;

  const access = await prisma.siteAccess.findFirst({
    where: {
      userId: caller.sub,
      organisationId: caller.orgId,
      site: { isActive: true },
    },
    orderBy: { grantedAt: 'asc' },
    select: { siteId: true },
  });
  if (access?.siteId) return access.siteId;

  if (caller.orgRole === OrgRole.SUPER_ADMIN) {
    const site = await prisma.site.findFirst({
      where: { organisationId: caller.orgId, isActive: true },
      orderBy: { id: 'asc' },
      select: { id: true },
    });
    if (site?.id) return site.id;
  }

  return null;
}
