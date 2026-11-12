import { BadRequestException } from '@nestjs/common';
import { ConsolidatedItemOutcome, ConsolidatedRejectionReason } from '@prisma/client';

/**
 * The rules that decide whether an item check is valid, and what each line
 * means — pure, so they can be tested without a database.
 *
 * These are the arithmetic that impact depends on. If accepted + rejected +
 * unavailable does not equal what was verified, the food has gone somewhere
 * nobody recorded, and every total downstream is wrong.
 */

/** Kilograms are floats; exact equality would reject honest input. */
export const ITEM_CHECK_EPSILON = 0.001;

export interface ItemCheckLine {
  masterFoodItemId: number;
  acceptedQtyKg: number;
  rejectedQtyKg: number;
  unavailableQtyKg: number;
  rejectionReason?: ConsolidatedRejectionReason | null;
  rejectionNote?: string | null;
}

export interface LedgerLine {
  masterFoodItemId: number;
  verifiedQtyKg: number;
}

/**
 * Throws on the first problem, with a message a charity volunteer can act on.
 *
 * Every verified item must appear exactly once: silence is not the same as
 * "none arrived", and treating a missing line as zero would quietly write off
 * a site's food.
 */
export function validateItemCheck(lines: ItemCheckLine[], ledger: LedgerLine[]): void {
  const expected = new Map(ledger.map((l) => [l.masterFoodItemId, l.verifiedQtyKg]));
  const seen = new Set<number>();

  for (const line of lines) {
    if (!expected.has(line.masterFoodItemId)) {
      throw new BadRequestException(
        `Item ${line.masterFoodItemId} is not part of this collection.`,
      );
    }
    if (seen.has(line.masterFoodItemId)) {
      throw new BadRequestException('Each item may only be recorded once.');
    }
    seen.add(line.masterFoodItemId);

    if (line.acceptedQtyKg < 0 || line.rejectedQtyKg < 0 || line.unavailableQtyKg < 0) {
      throw new BadRequestException('Quantities cannot be negative.');
    }

    const verified = expected.get(line.masterFoodItemId)!;
    const total = line.acceptedQtyKg + line.rejectedQtyKg + line.unavailableQtyKg;
    if (Math.abs(total - verified) > ITEM_CHECK_EPSILON) {
      throw new BadRequestException(
        `Accepted, rejected and unavailable must add up to ${verified} kg for this item.`,
      );
    }

    if (line.rejectedQtyKg > 0 && !line.rejectionReason) {
      throw new BadRequestException('Give a reason for anything you rejected.');
    }
    if (
      line.rejectionReason === ConsolidatedRejectionReason.OTHER &&
      !line.rejectionNote?.trim()
    ) {
      throw new BadRequestException('Describe the reason when choosing "Other".');
    }
  }

  if (seen.size !== expected.size) {
    throw new BadRequestException('Record every item before submitting.');
  }
}

/**
 * What happened to one item.
 *
 * Checked in order: everything taken, some taken, nothing there at all, and
 * finally rejected — so "nothing arrived" is never reported as "we refused it".
 */
export function outcomeFor(line: ItemCheckLine, verifiedQtyKg: number): ConsolidatedItemOutcome {
  if (line.acceptedQtyKg >= verifiedQtyKg - ITEM_CHECK_EPSILON) {
    return ConsolidatedItemOutcome.ACCEPTED;
  }
  if (line.acceptedQtyKg > 0) return ConsolidatedItemOutcome.PARTIALLY_ACCEPTED;
  if (line.unavailableQtyKg >= verifiedQtyKg - ITEM_CHECK_EPSILON) {
    return ConsolidatedItemOutcome.UNAVAILABLE;
  }
  return ConsolidatedItemOutcome.REJECTED;
}

/**
 * The three totals that must agree before anything is saved: what the
 * allocations give each site, what the charity's own claim says it took, and
 * what the ledger recorded.
 */
export function totalsReconcile(
  allocationsKg: number,
  masterClaimKg: number,
  ledgerAcceptedKg: number,
): boolean {
  return (
    Math.abs(allocationsKg - masterClaimKg) <= ITEM_CHECK_EPSILON &&
    Math.abs(allocationsKg - ledgerAcceptedKg) <= ITEM_CHECK_EPSILON
  );
}
