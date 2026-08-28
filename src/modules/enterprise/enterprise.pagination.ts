import { BadRequestException } from '@nestjs/common';

/** Page sizes the portal offers. Anything else is rejected rather than clamped. */
export const PAGE_SIZES = [25, 50, 100] as const;
export const DEFAULT_PAGE_SIZE = 25;

export interface PageRequest {
  page: number;
  pageSize: number;
  skip: number;
  take: number;
}

export interface Paginated<T> {
  rows: T[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
    /** Ready to render as "Showing 1–25 of 428". */
    from: number;
    to: number;
  };
}

/**
 * Normalises page params.
 *
 * Rejecting an unsupported page size rather than silently clamping it keeps a
 * client bug visible instead of turning it into a mysteriously truncated
 * export.
 */
export function pageRequest(page?: number, pageSize?: number): PageRequest {
  const p = Math.max(1, Math.floor(page ?? 1));
  const size = Math.floor(pageSize ?? DEFAULT_PAGE_SIZE);

  if (!PAGE_SIZES.includes(size as (typeof PAGE_SIZES)[number])) {
    throw new BadRequestException(
      `pageSize must be one of ${PAGE_SIZES.join(', ')}`,
    );
  }

  return { page: p, pageSize: size, skip: (p - 1) * size, take: size };
}

export function paginate<T>(
  rows: T[],
  total: number,
  req: PageRequest,
): Paginated<T> {
  const totalPages = total === 0 ? 0 : Math.ceil(total / req.pageSize);
  return {
    rows,
    pagination: {
      page: req.page,
      pageSize: req.pageSize,
      total,
      totalPages,
      from: total === 0 ? 0 : req.skip + 1,
      to: Math.min(req.skip + req.take, total),
    },
  };
}

// ─── Shared filters ──────────────────────────────────────────────────────────

/**
 * The filter set that every Enterprise screen shares: Group, Territory,
 * Cluster, Site and Period. They combine, so a request naming both a Group and
 * a Territory means the sites in *both*, not either.
 */
export interface EnterpriseFilters {
  groupId?: number;
  territoryId?: number;
  clusterId?: number;
  siteId?: number;
  from: Date;
  to: Date;
}

/** Period presets the portal offers, expressed in days. */
export const PERIOD_DAYS: Record<string, number> = {
  '7d': 7,
  '30d': 30,
  '90d': 90,
};

export const DEFAULT_PERIOD = '30d';

/**
 * Resolves a period into an explicit range. An explicit `from`/`to` pair wins
 * over a preset, which is what "Custom" in the period picker sends.
 */
export function resolvePeriod(
  period?: string,
  from?: string,
  to?: string,
): { from: Date; to: Date } {
  if (from && to) {
    const f = new Date(from);
    const t = new Date(to);
    if (Number.isNaN(+f) || Number.isNaN(+t)) {
      throw new BadRequestException('from and to must be valid dates');
    }
    if (f > t) throw new BadRequestException('from must not be after to');
    return { from: f, to: t };
  }

  const days = PERIOD_DAYS[period ?? DEFAULT_PERIOD];
  if (!days) {
    throw new BadRequestException(
      `period must be one of ${Object.keys(PERIOD_DAYS).join(', ')}, or supply from and to`,
    );
  }

  const end = new Date();
  const start = new Date(end);
  start.setDate(start.getDate() - days);
  return { from: start, to: end };
}

/**
 * The equivalent window immediately before the selected one, for
 * previous-period comparison. Returns null where the range is degenerate —
 * the portal shows a dash rather than an invented percentage.
 */
export function previousPeriod(
  from: Date,
  to: Date,
): { from: Date; to: Date } | null {
  const span = +to - +from;
  if (span <= 0) return null;
  return { from: new Date(+from - span), to: new Date(from) };
}

/**
 * Percentage change against the previous period, or null when there is not
 * enough comparable data to state one honestly.
 */
export function percentChange(
  current: number,
  previous: number,
): number | null {
  if (!Number.isFinite(current) || !Number.isFinite(previous)) return null;
  if (previous === 0) return null;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}
