import { Injectable, Logger } from '@nestjs/common';
import { RecoveryPathway } from '@prisma/client';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import {
  CO2_PER_KG,
  FOOD_VALUE_PER_KG_USD,
  MEAL_WEIGHT_KG,
} from '../../impact/impact.constants';

/** The three conversions every Enterprise impact figure is built from. */
export const IMPACT_FACTOR_KEY = {
  MEALS_PER_KG: 'meals_per_kg',
  CO2E_KG_PER_KG: 'co2e_kg_per_kg',
  VALUE_PER_KG: 'value_per_kg',
} as const;

export type ImpactFactorKey =
  (typeof IMPACT_FACTOR_KEY)[keyof typeof IMPACT_FACTOR_KEY];

/** Kilograms split by pathway. Absent pathways count as zero. */
export type PathwayKg = Partial<Record<RecoveryPathway, number>>;

export interface ImpactTotals {
  foodRecoveredKg: number;
  mealsCreated: number;
  co2AvoidedKg: number;
  /** Denominated in the Enterprise's configured currency. */
  estimatedFoodValue: number;
}

/** Falls back to the app-wide constants when no factor row covers a key. */
const DEFAULTS: Record<ImpactFactorKey, number> = {
  [IMPACT_FACTOR_KEY.MEALS_PER_KG]: 1 / MEAL_WEIGHT_KG,
  [IMPACT_FACTOR_KEY.CO2E_KG_PER_KG]: CO2_PER_KG,
  [IMPACT_FACTOR_KEY.VALUE_PER_KG]: FOOD_VALUE_PER_KG_USD,
};

const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * The single source of impact arithmetic.
 *
 * The Enterprise requirements are explicit that food recovered, meals created,
 * CO₂e avoided and estimated food value must reconcile across Dashboard, Site
 * Detail, Insights and generated reports. That only holds if one service owns
 * the conversions — so no caller should ever multiply kilograms by a constant
 * of its own.
 *
 * Factors are versioned by `effectiveFrom` rather than edited in place, which
 * keeps a report re-run over last quarter reproducible after a methodology
 * change.
 */
@Injectable()
export class EnterpriseImpactService {
  private readonly logger = new Logger(EnterpriseImpactService.name);
  private cache: { at: number; rows: FactorRow[] } | null = null;

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Resolves one factor at a point in time. A pathway-specific row wins over
   * the pathway-agnostic row; the constant is the last resort.
   */
  async factor(
    key: ImpactFactorKey,
    pathway: RecoveryPathway | null,
    at: Date = new Date(),
  ): Promise<number> {
    const rows = await this.load();
    const live = rows.filter(
      (r) =>
        r.key === key &&
        r.effectiveFrom <= at &&
        (r.effectiveTo === null || r.effectiveTo > at),
    );

    const specific = live
      .filter((r) => r.pathway === pathway)
      .sort((a, b) => +b.effectiveFrom - +a.effectiveFrom)[0];
    if (specific) return specific.value;

    const generic = live
      .filter((r) => r.pathway === null)
      .sort((a, b) => +b.effectiveFrom - +a.effectiveFrom)[0];
    if (generic) return generic.value;

    return DEFAULTS[key];
  }

  /**
   * Totals for a period.
   *
   * Meals are counted only from food that reached people — livestock feed,
   * circular recovery and bioenergy divert waste but do not feed anyone, and
   * reporting them as meals would overstate the headline figure.
   */
  async compute(byPathway: PathwayKg, at: Date = new Date()): Promise<ImpactTotals> {
    const entries = Object.entries(byPathway) as [RecoveryPathway, number][];
    const totalKg = entries.reduce((sum, [, kg]) => sum + (kg || 0), 0);
    const forPeopleKg = byPathway[RecoveryPathway.FOOD_FOR_PEOPLE] ?? 0;

    const [mealsPerKg, co2PerKg] = await Promise.all([
      this.factor(IMPACT_FACTOR_KEY.MEALS_PER_KG, RecoveryPathway.FOOD_FOR_PEOPLE, at),
      this.factor(IMPACT_FACTOR_KEY.CO2E_KG_PER_KG, null, at),
    ]);

    // Value varies by pathway — a kilogram diverted to bioenergy is not worth
    // the same as a kilogram of prepared meals.
    let value = 0;
    for (const [pathway, kg] of entries) {
      if (!kg) continue;
      value += kg * (await this.factor(IMPACT_FACTOR_KEY.VALUE_PER_KG, pathway, at));
    }

    return {
      foodRecoveredKg: round2(totalKg),
      mealsCreated: Math.round(forPeopleKg * mealsPerKg),
      co2AvoidedKg: round2(totalKg * co2PerKg),
      estimatedFoodValue: round2(value),
    };
  }

  /** Zeroed totals, so empty states never render `null` or `NaN`. */
  empty(): ImpactTotals {
    return {
      foodRecoveredKg: 0,
      mealsCreated: 0,
      co2AvoidedKg: 0,
      estimatedFoodValue: 0,
    };
  }

  /** Drops the cache so a factor change takes effect without a restart. */
  invalidate(): void {
    this.cache = null;
  }

  private async load(): Promise<FactorRow[]> {
    if (this.cache && Date.now() - this.cache.at < CACHE_TTL_MS) {
      return this.cache.rows;
    }

    try {
      const rows = await this.prisma.impactFactor.findMany({
        select: {
          key: true,
          pathway: true,
          value: true,
          effectiveFrom: true,
          effectiveTo: true,
        },
      });
      this.cache = { at: Date.now(), rows };
      return rows;
    } catch (err) {
      // A missing or unreachable table must not take down every impact figure.
      this.logger.warn(`impact factors unavailable, using defaults: ${(err as Error).message}`);
      return [];
    }
  }
}

interface FactorRow {
  key: string;
  pathway: RecoveryPathway | null;
  value: number;
  effectiveFrom: Date;
  effectiveTo: Date | null;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
