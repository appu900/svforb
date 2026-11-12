import {
  MATERIAL_REASON,
  diffMaterial,
  type ConsolidatedSnapshot,
} from './consolidated-material-change';

const TZ = 'Australia/Melbourne';

function snapshot(over: Partial<ConsolidatedSnapshot> = {}): ConsolidatedSnapshot {
  return {
    pointName: 'Loading Dock B',
    pointAddress: '1 Olympic Blvd, Melbourne',
    pickupStartAt: new Date('2026-12-04T03:00:00.000Z'),
    pickupEndAt: new Date('2026-12-04T04:00:00.000Z'),
    storage: { refrigeration: true, ambient: false, freezer: false, hot: false, reheating: false },
    allergens: ['gluten'],
    items: [
      { key: '1', name: 'Sandwiches', category: 'Bakery', qtyKg: 60 },
      { key: '2', name: 'Salads', category: 'Produce', qtyKg: 40 },
    ],
    ...over,
  };
}

/** Same items, with the first one's weight replaced. */
function withFirstQty(qtyKg: number): ConsolidatedSnapshot {
  const base = snapshot();
  return { ...base, items: [{ ...base.items[0], qtyKg }, base.items[1]] };
}

describe('diffMaterial', () => {
  it('reports nothing when the snapshots match', () => {
    const result = diffMaterial(snapshot(), snapshot(), TZ);
    expect(result.isMaterial).toBe(false);
    expect(result.reasons).toEqual([]);
    expect(result.summary).toBe('');
  });

  // The threshold is the whole point of the rule, so test both sides of it.
  it('treats a 19% total drop as not material', () => {
    // 100 kg -> 81 kg
    const result = diffMaterial(snapshot(), withFirstQty(41), TZ);
    expect(result.reasons).not.toContain(MATERIAL_REASON.QTY_DROP_GT_20);
  });

  it('treats a 21% total drop as material', () => {
    // 100 kg -> 79 kg
    const result = diffMaterial(snapshot(), withFirstQty(39), TZ);
    expect(result.isMaterial).toBe(true);
    expect(result.reasons).toContain(MATERIAL_REASON.QTY_DROP_GT_20);
    expect(result.summary).toContain('79 kg');
  });

  it('never treats an increase as material', () => {
    const result = diffMaterial(snapshot(), withFirstQty(200), TZ);
    expect(result.isMaterial).toBe(false);
  });

  it('treats a removed item as material even when it is tiny', () => {
    const before = snapshot({
      items: [
        { key: '1', name: 'Sandwiches', category: 'Bakery', qtyKg: 95 },
        { key: '2', name: 'Garnish', category: 'Produce', qtyKg: 5 },
      ],
    });
    const after = { ...before, items: [before.items[0]] };

    const result = diffMaterial(before, after, TZ);
    expect(result.isMaterial).toBe(true);
    expect(result.reasons).toContain(MATERIAL_REASON.ITEM_REMOVED);
  });

  it('treats an added allergen as material', () => {
    const result = diffMaterial(snapshot(), snapshot({ allergens: ['gluten', 'nuts'] }), TZ);
    expect(result.isMaterial).toBe(true);
    expect(result.reasons).toContain(MATERIAL_REASON.HANDLING);
  });

  it('ignores allergen reordering and casing', () => {
    const before = snapshot({ allergens: ['Gluten', 'nuts'] });
    const after = snapshot({ allergens: ['NUTS', 'gluten'] });
    expect(diffMaterial(before, after, TZ).isMaterial).toBe(false);
  });

  it('treats a storage change as material', () => {
    const result = diffMaterial(
      snapshot(),
      snapshot({
        storage: { refrigeration: false, ambient: true, freezer: false, hot: false, reheating: false },
      }),
      TZ,
    );
    expect(result.reasons).toContain(MATERIAL_REASON.HANDLING);
  });

  it('treats a location change as material', () => {
    const result = diffMaterial(snapshot(), snapshot({ pointName: 'Loading Dock C' }), TZ);
    expect(result.isMaterial).toBe(true);
    expect(result.reasons).toContain(MATERIAL_REASON.LOCATION);
    expect(result.summary).toContain('Loading Dock C');
  });

  it('treats a pickup time change as material', () => {
    const result = diffMaterial(
      snapshot(),
      snapshot({ pickupStartAt: new Date('2026-12-04T03:30:00.000Z') }),
      TZ,
    );
    expect(result.isMaterial).toBe(true);
    expect(result.reasons).toContain(MATERIAL_REASON.PICKUP_TIME);
  });

  it('catches a category drop even when the total barely moves', () => {
    // Produce 40 -> 10, but Bakery rises so the total only falls 10%.
    const after = snapshot({
      items: [
        { key: '1', name: 'Sandwiches', category: 'Bakery', qtyKg: 80 },
        { key: '2', name: 'Salads', category: 'Produce', qtyKg: 10 },
      ],
    });
    const result = diffMaterial(snapshot(), after, TZ);
    expect(result.reasons).toContain(MATERIAL_REASON.CATEGORY_DROP_GT_20);
    expect(result.reasons).not.toContain(MATERIAL_REASON.QTY_DROP_GT_20);
  });

  it('groups uncategorised items together rather than dropping them', () => {
    const before = snapshot({
      items: [{ key: '1', name: 'Mixed', category: null, qtyKg: 100 }],
    });
    const after = snapshot({
      items: [{ key: '1', name: 'Mixed', category: null, qtyKg: 50 }],
    });
    const result = diffMaterial(before, after, TZ);
    expect(result.reasons).toContain(MATERIAL_REASON.CATEGORY_DROP_GT_20);
    expect(result.summary).toContain('Uncategorised');
  });

  it('never names a contributing site in the summary', () => {
    const before = snapshot();
    const after = snapshot({ pointName: 'Dock C', items: [before.items[0]] });
    const result = diffMaterial(before, after, TZ);
    expect(result.summary).not.toMatch(/kiosk|site|outlet/i);
  });
});
