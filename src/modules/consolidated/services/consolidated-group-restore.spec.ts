import { ConflictException } from '@nestjs/common';
import { ConsolidatedGroupService } from './consolidated-group.service';

describe('Restoring an archived group', () => {
  function service(isActive: boolean) {
    const update = jest.fn(async () => ({}));
    const prisma: any = { $transaction: (fn: any) => fn({ consolidatedGroup: { update } }) };
    const access: any = { assertManager: jest.fn(async () => ({ id: 5, name: 'Winter Festival', organisationId: 1, isActive })) };
    const audit: any = { actorFrom: jest.fn(async () => ({})), log: jest.fn() };
    return { svc: new ConsolidatedGroupService(prisma, access, audit), update, audit };
  }

  it('reactivates an archived group and audits it', async () => {
    const { svc, update, audit } = service(false);
    await expect(svc.restore({ sub: 1, orgId: 1 } as any, 5)).resolves.toEqual({ restored: true });
    expect(update).toHaveBeenCalledWith({ where: { id: 5 }, data: { isActive: true, archivedAt: null } });
    expect(audit.log).toHaveBeenCalled();
  });

  it('refuses a group that is not archived', async () => {
    const { svc, update } = service(true);
    await expect(svc.restore({ sub: 1, orgId: 1 } as any, 5)).rejects.toBeInstanceOf(ConflictException);
    expect(update).not.toHaveBeenCalled();
  });
});
