import { OrgRole, Prisma, PrismaClient } from '@prisma/client';

const HEAD_OFFICE_ROLES: OrgRole[] = [OrgRole.SUPER_ADMIN, OrgRole.ORG_ADMIN];

/**
 * Users who should hear about one site's listings: that site's team plus head
 * office. Single-site organisations, or calls without a site, reach every
 * member of the organisation.
 */
export async function siteAudienceUserIds(
  prisma: Pick<PrismaClient, 'user' | 'site'>,
  orgId: number,
  siteId?: number | null,
  options: { activeOnly?: boolean } = {},
): Promise<number[]> {
  const active: Prisma.UserWhereInput = options.activeOnly ? { isActive: true } : {};
  const multiSite =
    siteId != null && (await prisma.site.count({ where: { organisationId: orgId } })) > 1;

  const where: Prisma.UserWhereInput = multiSite
    ? {
        ...active,
        OR: [
          { siteAccesses: { some: { siteId: siteId! } } },
          {
            orgMemeberShips: {
              some: { organisationId: orgId, orgRole: { in: HEAD_OFFICE_ROLES } },
            },
          },
        ],
      }
    : { ...active, orgMemeberShips: { some: { organisationId: orgId } } };

  const users = await prisma.user.findMany({ where, select: { id: true } });
  return users.map((u) => u.id);
}
