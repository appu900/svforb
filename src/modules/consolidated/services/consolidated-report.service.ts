import { ForbiddenException, Injectable } from '@nestjs/common';
import {
  ConsolidatedCollectionStatus, ConsolidatedMemberRole, Prisma,
} from '@prisma/client';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { Jwtpayload } from '../../auth/interface/jwt.interface';
import { ConsolidatedReportQueryDto } from '../dto/report.dto';
import { ConsolidatedAccessService } from './consolidated-access.service';

/**
 * Collections that have gone far enough to be worth reporting on. Scheduled
 * and open ones are not results yet.
 */
const REPORTABLE: ConsolidatedCollectionStatus[] = [
  ConsolidatedCollectionStatus.PUBLISHED,
  ConsolidatedCollectionStatus.CLAIMED,
  ConsolidatedCollectionStatus.AWAITING_ITEM_CHECK,
  ConsolidatedCollectionStatus.COMPLETED,
  ConsolidatedCollectionStatus.EXPIRED,
  ConsolidatedCollectionStatus.CANCELLED,
];

const DEFAULT_PAGE_SIZE = 25;

/**
 * Site-by-site and combined results.
 *
 * Everything is read from the item ledger rather than from claims, because the
 * ledger is the only place that keeps the whole chain — listed, verified,
 * accepted, rejected, unavailable — for one physical item (R19). Impact is
 * attributed by what was actually accepted, never pro rata.
 */
@Injectable()
export class ConsolidatedReportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ConsolidatedAccessService,
  ) {}

  // ─── Scope ─────────────────────────────────────────────────────────────────

  /**
   * Which groups the caller may report on.
   *
   * A manager sees the groups they run. A site user sees nothing at group
   * level — they report on their own site instead, which is why `siteId` is
   * required of them.
   */
  private async scope(caller: Jwtpayload, query: ConsolidatedReportQueryDto) {
    this.access.assertProductAccess(caller);

    const isOwner = caller.orgRole === 'SUPER_ADMIN';
    let groupIds: number[] | null = null;

    if (!isOwner) {
      const memberships = await this.prisma.consolidatedGroupMember.findMany({
        where: {
          userId: caller.sub,
          role: ConsolidatedMemberRole.MANAGER,
          group: { organisationId: caller.orgId },
        },
        select: { groupId: true },
      });
      groupIds = memberships.map((m) => m.groupId);
    }

    if (query.siteId) {
      // A site user may look at their own site; a manager at any site they run.
      await this.access.assertSiteUser(caller, query.siteId);
      // Someone who manages no groups is still entitled to their own site's
      // numbers. Leaving an empty group list in place would filter to nothing
      // and silently report zero rather than refusing.
      if ((groupIds?.length ?? 0) === 0) groupIds = null;
    } else if (!isOwner && (groupIds?.length ?? 0) === 0) {
      throw new ForbiddenException(
        'You can only report on a site you have access to.',
      );
    }

    if (query.groupId) {
      if (groupIds !== null && !groupIds.includes(query.groupId)) {
        throw new ForbiddenException('You do not manage this collection group.');
      }
      groupIds = [query.groupId];
    }

    return { groupIds, siteId: query.siteId ?? null, isManager: isOwner || (groupIds?.length ?? 0) > 0 };
  }

  private collectionWhere(
    caller: Jwtpayload,
    query: ConsolidatedReportQueryDto,
    groupIds: number[] | null,
  ): Prisma.ConsolidatedCollectionWhereInput {
    return {
      organisationId: caller.orgId,
      status: { in: REPORTABLE },
      ...(groupIds === null ? {} : { groupId: { in: groupIds } }),
      ...(query.from || query.to
        ? {
            scheduledDate: {
              ...(query.from ? { gte: new Date(query.from) } : {}),
              ...(query.to ? { lte: new Date(query.to) } : {}),
            },
          }
        : {}),
    };
  }

  // ─── Summary ───────────────────────────────────────────────────────────────

  async summary(caller: Jwtpayload, query: ConsolidatedReportQueryDto) {
    const { groupIds, siteId } = await this.scope(caller, query);

    const items = await this.prisma.consolidatedItem.findMany({
      where: {
        ...(siteId ? { siteId } : {}),
        collection: this.collectionWhere(caller, query, groupIds),
      },
      select: {
        siteId: true,
        category: true,
        submittedQtyKg: true,
        verifiedQtyKg: true,
        acceptedQtyKg: true,
        rejectedQtyKg: true,
        unavailableQtyKg: true,
        rejectionReason: true,
      },
    });

    const bySite = new Map<number, ReturnType<typeof this.emptyTotals>>();
    const byCategory = new Map<string, number>();
    const byReason = new Map<string, number>();
    const combined = this.emptyTotals();

    for (const item of items) {
      const site = bySite.get(item.siteId) ?? this.emptyTotals();
      this.add(site, item);
      bySite.set(item.siteId, site);
      this.add(combined, item);

      if (item.category && (item.acceptedQtyKg ?? 0) > 0) {
        byCategory.set(item.category, (byCategory.get(item.category) ?? 0) + (item.acceptedQtyKg ?? 0));
      }
      if (item.rejectionReason && (item.rejectedQtyKg ?? 0) > 0) {
        byReason.set(item.rejectionReason, (byReason.get(item.rejectionReason) ?? 0) + 1);
      }
    }

    const sites = await this.prisma.site.findMany({
      where: { id: { in: [...bySite.keys()] } },
      select: { id: true, name: true, organisationName: true },
    });
    const siteName = new Map(sites.map((s) => [s.id, s.name ?? s.organisationName]));

    return {
      combined: this.round(combined),
      sites: [...bySite.entries()]
        .map(([id, totals]) => ({
          siteId: id,
          siteName: siteName.get(id) ?? `Site ${id}`,
          ...this.round(totals),
        }))
        .sort((a, b) => b.acceptedKg - a.acceptedKg),
      categories: [...byCategory.entries()]
        .map(([category, kg]) => ({ category, acceptedKg: Number(kg.toFixed(2)) }))
        .sort((a, b) => b.acceptedKg - a.acceptedKg),
      rejectionReasons: [...byReason.entries()]
        .map(([reason, count]) => ({ reason, count }))
        .sort((a, b) => b.count - a.count),
    };
  }

  // ─── Per collection ────────────────────────────────────────────────────────

  async collections(caller: Jwtpayload, query: ConsolidatedReportQueryDto) {
    const { groupIds, siteId, isManager } = await this.scope(caller, query);
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, query.pageSize ?? DEFAULT_PAGE_SIZE));

    const where: Prisma.ConsolidatedCollectionWhereInput = {
      ...this.collectionWhere(caller, query, groupIds),
      ...(siteId ? { contributions: { some: { siteId } } } : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.consolidatedCollection.findMany({
        where,
        orderBy: { scheduledDate: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          group: { select: { name: true } },
          items: {
            where: siteId ? { siteId } : {},
            select: {
              siteId: true,
              submittedQtyKg: true,
              verifiedQtyKg: true,
              acceptedQtyKg: true,
              rejectedQtyKg: true,
              unavailableQtyKg: true,
            },
          },
          masterListing: {
            select: {
              foodClaims: {
                where: { claimKind: 'CONSOLIDATED_MASTER' },
                take: 1,
                select: { claimantOrg: { select: { name: true } } },
              },
            },
          },
        },
      }),
      this.prisma.consolidatedCollection.count({ where }),
    ]);

    return {
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
      rows: rows.map((row) => {
        const totals = this.emptyTotals();
        for (const item of row.items) this.add(totals, item);

        return {
          id: row.id,
          date: row.scheduledDate,
          groupName: row.group.name,
          pointName: row.pointName,
          status: row.status,
          ...this.round(totals),
          sitesContributed: new Set(row.items.map((i) => i.siteId)).size,
          // A site sees its own numbers, not who collected them.
          ...(isManager
            ? { charityName: row.masterListing?.foodClaims[0]?.claimantOrg.name ?? null }
            : {}),
        };
      }),
    };
  }

  // ─── Totals ────────────────────────────────────────────────────────────────

  private emptyTotals() {
    return { listedKg: 0, verifiedKg: 0, acceptedKg: 0, rejectedKg: 0, unavailableKg: 0 };
  }

  private add(
    totals: ReturnType<typeof this.emptyTotals>,
    item: {
      submittedQtyKg: number;
      verifiedQtyKg: number | null;
      acceptedQtyKg: number | null;
      rejectedQtyKg: number | null;
      unavailableQtyKg: number | null;
    },
  ) {
    totals.listedKg += item.submittedQtyKg;
    totals.verifiedKg += item.verifiedQtyKg ?? 0;
    totals.acceptedKg += item.acceptedQtyKg ?? 0;
    totals.rejectedKg += item.rejectedQtyKg ?? 0;
    totals.unavailableKg += item.unavailableQtyKg ?? 0;
  }

  /** Floating-point addition drifts; the report should not show that. */
  private round(totals: ReturnType<typeof this.emptyTotals>) {
    return {
      listedKg: Number(totals.listedKg.toFixed(2)),
      verifiedKg: Number(totals.verifiedKg.toFixed(2)),
      acceptedKg: Number(totals.acceptedKg.toFixed(2)),
      rejectedKg: Number(totals.rejectedKg.toFixed(2)),
      unavailableKg: Number(totals.unavailableKg.toFixed(2)),
    };
  }
}
