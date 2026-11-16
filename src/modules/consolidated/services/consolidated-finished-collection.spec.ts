import { ConflictException } from '@nestjs/common';
import { isClosedForChanges } from '../consolidated.constants';
import { ConsolidatedContributionService } from './consolidated-contribution.service';

/**
 * Once food has left the collection point, nothing about it may change: the
 * charity holds it and impact is (or will be) counted from it.
 */
describe('Finished collections are closed for changes', () => {
  it('treats pickup-onwards states as closed, earlier states as open', () => {
    for (const s of ['AWAITING_ITEM_CHECK', 'COMPLETED', 'CANCELLED', 'EXPIRED']) expect(isClosedForChanges(s)).toBe(true);
    for (const s of ['SCHEDULED', 'OPEN', 'SUBMISSIONS_CLOSED', 'PUBLISHED', 'CLAIMED']) expect(isClosedForChanges(s)).toBe(false);
  });

  function service(collectionStatus: string) {
    const updateMany = jest.fn(async () => ({ count: 1 }));
    const prisma: any = {
      consolidatedChangeRequest: {
        findUnique: jest.fn(async () => ({
          id: 61, status: 'PENDING', contributionId: 90, payload: { foodItems: [] },
          contribution: { collection: { id: 43, groupId: 3, organisationId: 1, status: collectionStatus }, site: { name: 'Kiosk 1' } },
        })),
        updateMany,
      },
    };
    const access: any = { assertManager: jest.fn(async () => ({})) };
    const audit: any = { actorFrom: jest.fn(async () => ({})), log: jest.fn() };
    const svc = new ConsolidatedContributionService(prisma, access, audit, {} as any, {} as any, {} as any);
    return { svc, updateMany };
  }

  it('refuses to approve a change on a completed collection and closes the request', async () => {
    const { svc, updateMany } = service('COMPLETED');
    await expect(svc.decideChangeRequest({ sub: 1, orgId: 1 } as any, 61, true, {})).rejects.toBeInstanceOf(ConflictException);
    expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { collectionId: 43, status: 'PENDING' },
      data: expect.objectContaining({ status: 'CANCELLED' }),
    }));
  });

  it('refuses after the charity has collected (awaiting item check)', async () => {
    const { svc } = service('AWAITING_ITEM_CHECK');
    await expect(svc.decideChangeRequest({ sub: 1, orgId: 1 } as any, 61, true, {})).rejects.toBeInstanceOf(ConflictException);
  });
});
