import { ConflictException, NotFoundException } from '@nestjs/common';
import { ConsolidatedGroupService } from './consolidated-group.service';

/**
 * Canva CM1 — a site joins a collection group only once someone who runs it
 * accepts. Site Admins answer for their site; an org owner/admin answers only
 * for a site with no Site Admin.
 */
describe('Consolidated site invitations', () => {
  const siteAdmins = [{ siteId: 1, userId: 50 }]; // site 1 has a Site Admin; site 2 has none

  function service(extra: Record<string, unknown> = {}) {
    const prisma: any = {
      siteAccess: {
        findMany: jest.fn(async ({ where }: any) =>
          siteAdmins.filter((a) => where.siteId.in.includes(a.siteId))),
      },
      ...extra,
    };
    const access: any = { assertProductAccess: jest.fn() };
    const audit: any = { actorFrom: jest.fn(async () => ({})), log: jest.fn() };
    return { svc: new ConsolidatedGroupService(prisma, access, audit) as any, prisma };
  }

  const orgAdmin = { sub: 9, orgId: 1, orgRole: 'ORG_ADMIN' } as any;
  const siteAdmin = { sub: 50, orgId: 1, orgRole: 'ORG_MEMBER' } as any;
  const staff = { sub: 77, orgId: 1, orgRole: 'ORG_MEMBER' } as any;

  it('an org admin answers only for sites nobody administers', async () => {
    const { svc } = service();
    expect([...(await svc.canRespondFor(orgAdmin, [1, 2]))]).toEqual([2]);
  });

  it('a Site Admin answers for their own site', async () => {
    const { svc } = service();
    expect([...(await svc.canRespondFor(siteAdmin, [1, 2]))]).toEqual([1]);
  });

  it('ordinary staff answer for nothing', async () => {
    const { svc } = service();
    expect([...(await svc.canRespondFor(staff, [1, 2]))]).toEqual([]);
  });

  it('invites sites run by someone else, joins sites the inviter runs', async () => {
    const { svc } = service();
    const data = await svc.invitationData(orgAdmin, [1, 2]);
    expect(data.get(1).invitationStatus).toBe('PENDING');
    expect(data.get(2).invitationStatus).toBe('ACCEPTED');
  });

  it('refuses someone who cannot answer, without revealing the invitation', async () => {
    const { svc } = service({
      consolidatedGroupSite: {
        findFirst: jest.fn(async () => ({
          id: 3, siteId: 1, groupId: 4, removedAt: null, invitationStatus: 'PENDING',
          site: { name: 'Kiosk 1' }, group: { id: 4, name: 'Precinct', organisationId: 1 },
        })),
      },
    });
    await expect(svc.respondToInvitation(staff, 3, true)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('an invitation can be answered once', async () => {
    const { svc } = service({
      consolidatedGroupSite: {
        findFirst: jest.fn(async () => ({
          id: 3, siteId: 1, groupId: 4, removedAt: null, invitationStatus: 'ACCEPTED',
          site: { name: 'Kiosk 1' }, group: { id: 4, name: 'Precinct', organisationId: 1 },
        })),
      },
    });
    await expect(svc.respondToInvitation(siteAdmin, 3, true)).rejects.toBeInstanceOf(ConflictException);
  });
});
