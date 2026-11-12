/** Thresholds and windows for Consolidated Collections. See SPEC §11. */

/** How far ahead the sweep materialises collections from a schedule (A4). */
export const CONSOLIDATED_HORIZON_DAYS = 14;
export const CONSOLIDATED_SWEEP_EVERY_MS = 5 * 60_000;

export const CLOSING_REMINDER_MINUTES = 60;
export const PICKUP_REMINDER_MINUTES = 30;
export const ITEM_CHECK_REMINDER_HOURS = 24;

/** A drop beyond this needs charity acknowledgement (R11). Per-org in Phase 2. */
export const MATERIAL_QTY_DROP_PCT = 20;
export const MATERIAL_CATEGORY_DROP_PCT = 20;

export const MAX_MASTER_PHOTOS = 5;

/**
 * Declaration text is stored with every signature, so wording can change later
 * without rewriting what someone actually agreed to (R13, SPEC §6).
 */
export const DECLARATIONS = {
  SITE: {
    version: 'v1',
    text:
      'I confirm that the food and quantities recorded are accurate to the best of my knowledge, ' +
      'that the food is suitable for its intended redistribution, and that it has been handled and ' +
      'stored in accordance with applicable food safety requirements.',
  },
  MANAGER: {
    version: 'v1',
    text:
      'I confirm that the consolidated listing accurately reflects the food recorded and verified ' +
      'for this collection, and that the participating organisation remains responsible for ' +
      'applicable food safety and handling requirements.',
  },
  CHARITY: {
    version: 'v1',
    text:
      'I confirm that the quantities and condition of food accepted have been recorded, including ' +
      'rejected or unavailable items, and acknowledge responsibility for the safe handling, ' +
      'transport and use of accepted food following collection, in accordance with applicable ' +
      'requirements.',
  },
} as const;

/** Controllers and the sweep are inert unless this is on (B13 rollout). */
export function consolidatedEnabled(): boolean {
  return process.env.CONSOLIDATED_ENABLED === 'true';
}
