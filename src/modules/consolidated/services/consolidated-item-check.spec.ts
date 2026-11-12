import { BadRequestException } from '@nestjs/common';
import { ConsolidatedItemOutcome, ConsolidatedRejectionReason } from '@prisma/client';
import {
  ItemCheckLine, LedgerLine, outcomeFor, totalsReconcile, validateItemCheck,
} from './consolidated-item-check';

const ledger: LedgerLine[] = [
  { masterFoodItemId: 1, verifiedQtyKg: 4 },
  { masterFoodItemId: 2, verifiedQtyKg: 5 },
  { masterFoodItemId: 3, verifiedQtyKg: 8 },
];

function line(over: Partial<ItemCheckLine> & { masterFoodItemId: number }): ItemCheckLine {
  return { acceptedQtyKg: 0, rejectedQtyKg: 0, unavailableQtyKg: 0, ...over };
}

/** The scenario from the spec: 3 sites verify 4, 5, 8; the charity takes 4, 5, 6. */
const SCENARIO: ItemCheckLine[] = [
  line({ masterFoodItemId: 1, acceptedQtyKg: 4 }),
  line({ masterFoodItemId: 2, acceptedQtyKg: 5 }),
  line({
    masterFoodItemId: 3,
    acceptedQtyKg: 6,
    rejectedQtyKg: 2,
    rejectionReason: ConsolidatedRejectionReason.QUALITY,
  }),
];

describe('validateItemCheck', () => {
  it('accepts the reference scenario', () => {
    expect(() => validateItemCheck(SCENARIO, ledger)).not.toThrow();
  });

  it('accepts a whole item being unavailable', () => {
    expect(() =>
      validateItemCheck(
        [
          line({ masterFoodItemId: 1, acceptedQtyKg: 4 }),
          line({ masterFoodItemId: 2, acceptedQtyKg: 5 }),
          line({ masterFoodItemId: 3, unavailableQtyKg: 8 }),
        ],
        ledger,
      ),
    ).not.toThrow();
  });

  // The sum rule is the whole invariant — food that does not add up has gone
  // somewhere nobody recorded.
  it('rejects a short sum', () => {
    const lines = [...SCENARIO];
    lines[0] = line({ masterFoodItemId: 1, acceptedQtyKg: 3 });
    expect(() => validateItemCheck(lines, ledger)).toThrow(BadRequestException);
  });

  it('rejects a sum above what was verified', () => {
    const lines = [...SCENARIO];
    lines[0] = line({ masterFoodItemId: 1, acceptedQtyKg: 5 });
    expect(() => validateItemCheck(lines, ledger)).toThrow(BadRequestException);
  });

  it('tolerates floating-point noise', () => {
    const lines = [
      line({ masterFoodItemId: 1, acceptedQtyKg: 4.0000004 }),
      line({ masterFoodItemId: 2, acceptedQtyKg: 5 }),
      line({ masterFoodItemId: 3, acceptedQtyKg: 8 }),
    ];
    expect(() => validateItemCheck(lines, ledger)).not.toThrow();
  });

  it('rejects negative quantities', () => {
    const lines = [
      line({ masterFoodItemId: 1, acceptedQtyKg: 5, rejectedQtyKg: -1 }),
      line({ masterFoodItemId: 2, acceptedQtyKg: 5 }),
      line({ masterFoodItemId: 3, acceptedQtyKg: 8 }),
    ];
    expect(() => validateItemCheck(lines, ledger)).toThrow(BadRequestException);
  });

  it('requires every item to be recorded', () => {
    expect(() => validateItemCheck(SCENARIO.slice(0, 2), ledger)).toThrow(BadRequestException);
  });

  it('rejects a duplicated item', () => {
    const lines = [...SCENARIO, line({ masterFoodItemId: 1, acceptedQtyKg: 4 })];
    expect(() => validateItemCheck(lines, ledger)).toThrow(BadRequestException);
  });

  it('rejects an item that is not part of the collection', () => {
    const lines = [...SCENARIO, line({ masterFoodItemId: 99, acceptedQtyKg: 1 })];
    expect(() => validateItemCheck(lines, ledger)).toThrow(BadRequestException);
  });

  it('requires a reason whenever anything is rejected', () => {
    const lines = [...SCENARIO];
    lines[2] = line({ masterFoodItemId: 3, acceptedQtyKg: 6, rejectedQtyKg: 2 });
    expect(() => validateItemCheck(lines, ledger)).toThrow(BadRequestException);
  });

  it('requires a note when the reason is OTHER', () => {
    const lines = [...SCENARIO];
    lines[2] = line({
      masterFoodItemId: 3,
      acceptedQtyKg: 6,
      rejectedQtyKg: 2,
      rejectionReason: ConsolidatedRejectionReason.OTHER,
    });
    expect(() => validateItemCheck(lines, ledger)).toThrow(BadRequestException);

    lines[2] = { ...lines[2], rejectionNote: 'Packaging split in transit' };
    expect(() => validateItemCheck(lines, ledger)).not.toThrow();
  });

  it('does not require a note for a specific reason', () => {
    expect(() => validateItemCheck(SCENARIO, ledger)).not.toThrow();
  });
});

describe('outcomeFor', () => {
  it('everything taken is ACCEPTED', () => {
    expect(outcomeFor(line({ masterFoodItemId: 1, acceptedQtyKg: 4 }), 4))
      .toBe(ConsolidatedItemOutcome.ACCEPTED);
  });

  it('some taken is PARTIALLY_ACCEPTED', () => {
    expect(outcomeFor(
      line({ masterFoodItemId: 1, acceptedQtyKg: 3, rejectedQtyKg: 1 }), 4,
    )).toBe(ConsolidatedItemOutcome.PARTIALLY_ACCEPTED);
  });

  it('nothing there is UNAVAILABLE, not REJECTED', () => {
    expect(outcomeFor(line({ masterFoodItemId: 1, unavailableQtyKg: 4 }), 4))
      .toBe(ConsolidatedItemOutcome.UNAVAILABLE);
  });

  it('refused outright is REJECTED', () => {
    expect(outcomeFor(
      line({
        masterFoodItemId: 1,
        rejectedQtyKg: 4,
        rejectionReason: ConsolidatedRejectionReason.TEMPERATURE,
      }), 4,
    )).toBe(ConsolidatedItemOutcome.REJECTED);
  });

  it('mostly unavailable with a little rejected is still UNAVAILABLE only if all of it was', () => {
    expect(outcomeFor(
      line({
        masterFoodItemId: 1,
        unavailableQtyKg: 3,
        rejectedQtyKg: 1,
        rejectionReason: ConsolidatedRejectionReason.QUALITY,
      }), 4,
    )).toBe(ConsolidatedItemOutcome.REJECTED);
  });
});

describe('totalsReconcile', () => {
  // 4 + 5 + 6 = 15 across three sites, and the charity's own claim says 15.
  it('agrees for the reference scenario', () => {
    expect(totalsReconcile(15, 15, 15)).toBe(true);
  });

  it('tolerates floating-point noise', () => {
    expect(totalsReconcile(15, 15.0000005, 14.9999995)).toBe(true);
  });

  it('catches the master claim being counted as well as the allocations', () => {
    // 15 kg of allocations against a 30 kg total is the double-count this guards.
    expect(totalsReconcile(15, 30, 15)).toBe(false);
  });

  it('catches a site missing an allocation', () => {
    expect(totalsReconcile(9, 15, 15)).toBe(false);
  });

  it('catches a ledger that disagrees with what was written', () => {
    expect(totalsReconcile(15, 15, 17)).toBe(false);
  });
});
