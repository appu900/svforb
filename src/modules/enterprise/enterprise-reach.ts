import { ScopeType } from '@prisma/client';
import { PrismaService } from '../../infra/prisma/prisma.service';

/**
 * Sites a view-only Enterprise Admin is limited to, or null when they cover the
 * whole Enterprise.
 *
 * The role is Enterprise-wide by default; scope grants narrow it. Every read
 * path that would otherwise wave the role through calls this, so a site-limited
 * viewer cannot see more through one screen than another.
 */
export async function viewOnlySiteIds(
  prisma: PrismaService,
  userId: number,
  orgId: number,
): Promise<number[] | null> {
  const scopes = await prisma.userScope.findMany({
    where: { userId, organisationId: orgId },
    select: { scopeType: true, scopeId: true },
  });
  if (!scopes.length) return null;
  if (scopes.some((scope) => scope.scopeType === ScopeType.ENTERPRISE)) return null;

  const idsOf = (type: ScopeType) =>
    scopes.filter((scope) => scope.scopeType === type && scope.scopeId != null).map((scope) => scope.scopeId as number);

  const [sites, groupSites, clusterSites, territorySites] = await Promise.all([
    prisma.site.findMany({
      where: { id: { in: idsOf(ScopeType.SITE) }, organisationId: orgId },
      select: { id: true },
    }),
    prisma.groupSite.findMany({
      where: { groupId: { in: idsOf(ScopeType.GROUP) }, organisationId: orgId },
      select: { siteId: true },
    }),
    prisma.clusterSite.findMany({
      where: { clusterId: { in: idsOf(ScopeType.CLUSTER) }, cluster: { organisationId: orgId } },
      select: { siteId: true },
    }),
    prisma.territorySite.findMany({
      where: { territoryId: { in: idsOf(ScopeType.TERRITORY) }, territory: { organisationId: orgId } },
      select: { siteId: true },
    }),
  ]);

  return [
    ...new Set([
      ...sites.map((row) => row.id),
      ...groupSites.map((row) => row.siteId),
      ...clusterSites.map((row) => row.siteId),
      ...territorySites.map((row) => row.siteId),
    ]),
  ];
}
