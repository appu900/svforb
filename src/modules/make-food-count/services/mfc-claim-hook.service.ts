import { Injectable, Logger } from '@nestjs/common';
import { ClaimStatus, FoodRecordEventType, Prisma } from '@prisma/client';
import { PrismaService } from '../../../infra/prisma/prisma.service';

/**
 * Records what a claim did to the food a kitchen recorded.
 *
 * Called after the claim has already been committed, and every failure is
 * logged rather than thrown: Make Food Count observes collection, it must
 * never be able to break it.
 */
@Injectable()
export class MfcClaimHookService {
  private readonly logger = new Logger(MfcClaimHookService.name);

  async onClaimResolved(
    prisma: PrismaService, claimId: number, status: ClaimStatus,
  ): Promise<void> {
    if (status !== ClaimStatus.COLLECTED && status !== ClaimStatus.CANCELLED) return;

    try {
      // Only claims on items that came from a food record are of interest.
      const items = await prisma.claimItem.findMany({
        where: { claimId, foodItem: { foodRecordLink: { isNot: null } } },
        select: {
          qtyKg: true,
          foodItem: {
            select: {
              foodRecordLink: { select: { recordId: true, lineId: true } },
            },
          },
        },
      });
      if (!items.length) return;

      const type = status === ClaimStatus.COLLECTED
        ? FoodRecordEventType.CLAIM_COLLECTED
        : FoodRecordEventType.CLAIM_CANCELLED;

      await prisma.foodRecordEvent.createMany({
        data: items
          .filter((i) => i.foodItem.foodRecordLink)
          .map((i) => ({
            recordId: i.foodItem.foodRecordLink!.recordId,
            lineId: i.foodItem.foodRecordLink!.lineId,
            // No actor: the system observed this, nobody typed it.
            actorUserId: null,
            type,
            after: { claimId, qtyKg: i.qtyKg, status } as Prisma.InputJsonValue,
          })),
      });
    } catch (err) {
      this.logger.error(
        `Food record hook failed for claim ${claimId} (${status}): ${(err as Error).message}`,
      );
    }
  }
}
