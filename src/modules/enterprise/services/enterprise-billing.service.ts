import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  ContractStatus,
  InvoiceStatus,
  Prisma,
  SubscriptionStatus,
} from '@prisma/client';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { Jwtpayload } from '../../auth/interface/jwt.interface';
import {
  CreateContractDto,
  GenerateInvoiceDto,
  MarkInvoicePaidDto,
  UpdateContractDto,
} from '../dto/enterprise.dto';
import {
  addBillingPeriod,
  ENTERPRISE_ERROR,
  ENTERPRISE_PLAN_NAME,
} from '../enterprise.constants';

/**
 * Enterprise billing is settled offline — a platform admin negotiates a
 * per-site rate, the cron raises an invoice each cycle, and payment is recorded
 * by hand. Stripe is not involved at any point.
 */
@Injectable()
export class EnterpriseBillingService {
  private readonly logger = new Logger(EnterpriseBillingService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ─── Contracts (platform admin) ────────────────────────────────────────────

  async createContract(caller: Jwtpayload, dto: CreateContractDto) {
    const org = await this.prisma.organisation.findUnique({
      where: { id: dto.organisationId },
      select: { id: true, name: true },
    });
    if (!org) throw new NotFoundException('Organisation not found');

    const existing = await this.prisma.enterpriseContract.findUnique({
      where: { organisationId: dto.organisationId },
    });
    if (existing) {
      throw new ConflictException({
        error: ENTERPRISE_ERROR.CONTRACT_EXISTS,
        message: 'This organisation already has a contract. Update it instead.',
        contractId: existing.id,
      });
    }

    const startDate = new Date(dto.startDate);

    // The contract is what makes an organisation an Enterprise, so it also
    // puts them on the ENTERPRISE plan. Without this the org would hold a
    // contract but still fail every assertEnterprise() check.
    const plan = await this.prisma.subscriptionPlan.findUnique({
      where: { name: ENTERPRISE_PLAN_NAME },
      select: { id: true },
    });
    if (!plan) {
      throw new NotFoundException(
        'The ENTERPRISE plan is missing from the catalogue. Run the seed first.',
      );
    }

    const contract = await this.prisma.enterpriseContract.create({
      data: {
        organisationId: dto.organisationId,
        ratePerSiteCents: Math.round(dto.ratePerSite * 100),
        currency: (dto.currency ?? 'AUD').toUpperCase(),
        billingFrequency: dto.billingFrequency ?? 'MONTHLY',
        contractedSiteCount: dto.contractedSiteCount,
        taxRatePercent: dto.taxRatePercent ?? 0,
        startDate,
        endDate: dto.endDate ? new Date(dto.endDate) : null,
        paymentTermsDays: dto.paymentTermsDays ?? 30,
        // First invoice is raised on the start date itself.
        nextInvoiceOn: startDate,
        notes: dto.notes,
        createdBy: caller.sub,
      },
    });

    await this.prisma.orgSubscription.upsert({
      where: { organisationId: dto.organisationId },
      create: {
        organisationId: dto.organisationId,
        planId: plan.id,
        status: SubscriptionStatus.ACTIVE,
      },
      update: { planId: plan.id, status: SubscriptionStatus.ACTIVE },
    });

    this.logger.log(
      `Contract created: org=${org.name} rate=${contract.ratePerSiteCents}` +
        `${contract.currency}/site freq=${contract.billingFrequency} by=${caller.sub}`,
    );
    return this.formatContract(contract);
  }

  async listContracts() {
    const contracts = await this.prisma.enterpriseContract.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        organisation: { select: { id: true, name: true } },
        _count: { select: { invoices: true } },
      },
    });

    return Promise.all(
      contracts.map(async (c) => ({
        ...this.formatContract(c),
        organisation: c.organisation,
        invoiceCount: c._count.invoices,
        currentSiteCount: await this.prisma.site.count({
          where: { organisationId: c.organisationId },
        }),
      })),
    );
  }

  async getContract(organisationId: number) {
    const contract = await this.prisma.enterpriseContract.findUnique({
      where: { organisationId },
      include: { organisation: { select: { id: true, name: true } } },
    });
    if (!contract) throw new NotFoundException('No contract for this organisation');

    const siteCount = await this.prisma.site.count({ where: { organisationId } });

    return {
      ...this.formatContract(contract),
      organisation: contract.organisation,
      currentSiteCount: siteCount,
      /// What the next invoice would total at today's site count
      projectedTotal: this.computeTotals(
        siteCount,
        contract.ratePerSiteCents,
        contract.taxRatePercent,
      ),
    };
  }

  async updateContract(organisationId: number, dto: UpdateContractDto) {
    const contract = await this.prisma.enterpriseContract.findUnique({
      where: { organisationId },
    });
    if (!contract) throw new NotFoundException('No contract for this organisation');

    const updated = await this.prisma.enterpriseContract.update({
      where: { organisationId },
      data: {
        ...(dto.ratePerSite !== undefined && {
          ratePerSiteCents: Math.round(dto.ratePerSite * 100),
        }),
        ...(dto.billingFrequency && { billingFrequency: dto.billingFrequency }),
        ...(dto.contractedSiteCount !== undefined && {
          contractedSiteCount: dto.contractedSiteCount,
        }),
        ...(dto.taxRatePercent !== undefined && { taxRatePercent: dto.taxRatePercent }),
        ...(dto.endDate !== undefined && { endDate: new Date(dto.endDate) }),
        ...(dto.status && { status: dto.status }),
        ...(dto.paymentTermsDays !== undefined && {
          paymentTermsDays: dto.paymentTermsDays,
        }),
        ...(dto.notes !== undefined && { notes: dto.notes }),
      },
    });

    // Ending the deal must end the access, or the org keeps unlimited use
    // with nobody paying for it.
    if (dto.status) await this.syncSubscriptionToContract(organisationId, updated.status);

    this.logger.log(`Contract updated: org=${organisationId} status=${updated.status}`);
    return this.formatContract(updated);
  }

  // ─── Invoices ──────────────────────────────────────────────────────────────

  /**
   * Raises one invoice for a contract's current period.
   *
   * Total = live site count x the contract rate. The count and rate are stored
   * on the invoice, so renegotiating later never rewrites what was billed.
   * The unique index on (contractId, periodStart) makes a repeat run a no-op.
   */
  async generateInvoiceForContract(
    contractId: number,
    periodStartOverride?: Date,
  ): Promise<{ created: boolean; invoiceId?: number; reason?: string }> {
    const contract = await this.prisma.enterpriseContract.findUnique({
      where: { id: contractId },
    });
    if (!contract) return { created: false, reason: 'contract not found' };

    if (contract.status !== ContractStatus.ACTIVE) {
      return { created: false, reason: `contract is ${contract.status}` };
    }

    const periodStart = periodStartOverride ?? contract.nextInvoiceOn ?? contract.startDate;
    const periodEnd = addBillingPeriod(periodStart, contract.billingFrequency);

    if (contract.endDate && periodStart > contract.endDate) {
      await this.prisma.enterpriseContract.update({
        where: { id: contractId },
        data: { status: ContractStatus.EXPIRED },
      });
      return { created: false, reason: 'contract ended' };
    }

    const siteCount = await this.prisma.site.count({
      where: { organisationId: contract.organisationId },
    });
    const totals = this.computeTotals(
      siteCount,
      contract.ratePerSiteCents,
      contract.taxRatePercent,
    );

    const issuedAt = new Date();
    const dueAt = new Date(issuedAt);
    dueAt.setDate(dueAt.getDate() + contract.paymentTermsDays);

    try {
      const invoice = await this.prisma.$transaction(async (tx) => {
        const created = await tx.enterpriseInvoice.create({
          data: {
            invoiceNumber: await this.nextInvoiceNumber(tx),
            organisationId: contract.organisationId,
            contractId: contract.id,
            periodStart,
            periodEnd,
            siteCount,
            ratePerSiteCents: contract.ratePerSiteCents,
            subtotalCents: totals.subtotalCents,
            taxCents: totals.taxCents,
            totalCents: totals.totalCents,
            currency: contract.currency,
            status: InvoiceStatus.ISSUED,
            issuedAt,
            dueAt,
          },
        });

        await tx.enterpriseContract.update({
          where: { id: contract.id },
          data: { nextInvoiceOn: periodEnd },
        });

        return created;
      });

      this.logger.log(
        `Invoice ${invoice.invoiceNumber}: org=${contract.organisationId} ` +
          `${siteCount} sites x ${contract.ratePerSiteCents}c = ${totals.totalCents}c`,
      );
      return { created: true, invoiceId: invoice.id };
    } catch (err) {
      // Unique (contractId, periodStart) — this period is already invoiced.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        return { created: false, reason: 'already invoiced for this period' };
      }
      throw err;
    }
  }

  /** Manual trigger for a platform admin. */
  async generateInvoice(dto: GenerateInvoiceDto) {
    const contract = await this.prisma.enterpriseContract.findUnique({
      where: { organisationId: dto.organisationId },
    });
    if (!contract) throw new NotFoundException('No contract for this organisation');

    // The unique index only stops the *same* period being billed twice. Without
    // this check a second click would bill the next cycle early, because the
    // first run has already advanced the anchor.
    if (!dto.periodStart && contract.nextInvoiceOn && contract.nextInvoiceOn > new Date()) {
      throw new ConflictException({
        error: ENTERPRISE_ERROR.ALREADY_INVOICED,
        message:
          'This period is already invoiced. The next invoice is due on ' +
          `${contract.nextInvoiceOn.toISOString().slice(0, 10)}. ` +
          'Pass periodStart explicitly to bill ahead of schedule.',
        nextInvoiceOn: contract.nextInvoiceOn,
      });
    }

    const result = await this.generateInvoiceForContract(
      contract.id,
      dto.periodStart ? new Date(dto.periodStart) : undefined,
    );

    if (!result.created) {
      throw new BadRequestException(`Invoice not generated: ${result.reason}`);
    }
    return this.getInvoice(result.invoiceId!);
  }

  async listInvoices(filters: { organisationId?: number; status?: InvoiceStatus }) {
    const invoices = await this.prisma.enterpriseInvoice.findMany({
      where: {
        ...(filters.organisationId && { organisationId: filters.organisationId }),
        ...(filters.status && { status: filters.status }),
      },
      orderBy: { periodStart: 'desc' },
      include: { organisation: { select: { id: true, name: true } } },
      take: 200,
    });
    return invoices.map((i) => this.formatInvoice(i));
  }

  async getInvoice(invoiceId: number) {
    const invoice = await this.prisma.enterpriseInvoice.findUnique({
      where: { id: invoiceId },
      include: { organisation: { select: { id: true, name: true, address: true } } },
    });
    if (!invoice) throw new NotFoundException('Invoice not found');
    return this.formatInvoice(invoice);
  }

  /** Records an offline payment — bank transfer, cheque, whatever. */
  async markInvoicePaid(caller: Jwtpayload, invoiceId: number, dto: MarkInvoicePaidDto) {
    const invoice = await this.prisma.enterpriseInvoice.findUnique({
      where: { id: invoiceId },
    });
    if (!invoice) throw new NotFoundException('Invoice not found');

    if (invoice.status === InvoiceStatus.PAID) {
      throw new ConflictException('This invoice is already marked paid');
    }
    if (invoice.status === InvoiceStatus.CANCELLED) {
      throw new BadRequestException({
        error: ENTERPRISE_ERROR.INVOICE_NOT_PAYABLE,
        message: 'A cancelled invoice cannot be marked paid',
      });
    }

    const updated = await this.prisma.enterpriseInvoice.update({
      where: { id: invoiceId },
      data: {
        status: InvoiceStatus.PAID,
        paidAt: dto.paidAt ? new Date(dto.paidAt) : new Date(),
        paidBy: caller.sub,
        paymentReference: dto.paymentReference,
        ...(dto.notes !== undefined && { notes: dto.notes }),
      },
    });

    this.logger.log(`Invoice ${updated.invoiceNumber} marked paid by=${caller.sub}`);
    return this.formatInvoice(updated);
  }

  async cancelInvoice(invoiceId: number, reason?: string) {
    const invoice = await this.prisma.enterpriseInvoice.findUnique({
      where: { id: invoiceId },
    });
    if (!invoice) throw new NotFoundException('Invoice not found');
    if (invoice.status === InvoiceStatus.PAID) {
      throw new ConflictException('A paid invoice cannot be cancelled — refund it instead');
    }

    const updated = await this.prisma.enterpriseInvoice.update({
      where: { id: invoiceId },
      data: { status: InvoiceStatus.CANCELLED, notes: reason ?? invoice.notes },
    });
    return this.formatInvoice(updated);
  }

  /** The Enterprise's own view of its invoices. */
  async listMyInvoices(caller: Jwtpayload) {
    if (!caller.orgId) throw new ForbiddenException('Not part of an organisation');
    return this.listInvoices({ organisationId: caller.orgId });
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  /** Keeps product access in step with the commercial agreement. */
  async syncSubscriptionToContract(organisationId: number, status: ContractStatus) {
    const map: Record<ContractStatus, SubscriptionStatus> = {
      DRAFT: SubscriptionStatus.PAST_DUE,
      ACTIVE: SubscriptionStatus.ACTIVE,
      EXPIRED: SubscriptionStatus.EXPIRED,
      TERMINATED: SubscriptionStatus.CANCELLED,
    };

    await this.prisma.orgSubscription
      .update({ where: { organisationId }, data: { status: map[status] } })
      .catch(() => undefined);
  }

  /** Expires contracts whose end date has passed — run daily by the worker. */
  async expireLapsedContracts(): Promise<number> {
    const lapsed = await this.prisma.enterpriseContract.findMany({
      where: {
        status: ContractStatus.ACTIVE,
        endDate: { not: null, lt: new Date() },
      },
      select: { id: true, organisationId: true },
    });
    if (!lapsed.length) return 0;

    await this.prisma.enterpriseContract.updateMany({
      where: { id: { in: lapsed.map((c) => c.id) } },
      data: { status: ContractStatus.EXPIRED },
    });

    for (const c of lapsed) {
      await this.syncSubscriptionToContract(c.organisationId, ContractStatus.EXPIRED);
    }

    this.logger.log(`Expired ${lapsed.length} lapsed contract(s)`);
    return lapsed.length;
  }

  private computeTotals(siteCount: number, ratePerSiteCents: number, taxRatePercent: number) {
    const subtotalCents = siteCount * ratePerSiteCents;
    const taxCents = Math.round(subtotalCents * (taxRatePercent / 100));
    return { subtotalCents, taxCents, totalCents: subtotalCents + taxCents };
  }

  /** INV-<year>-<zero padded sequence within that year>. */
  private async nextInvoiceNumber(tx: Prisma.TransactionClient): Promise<string> {
    const year = new Date().getFullYear();
    const prefix = `INV-${year}-`;

    const last = await tx.enterpriseInvoice.findFirst({
      where: { invoiceNumber: { startsWith: prefix } },
      orderBy: { invoiceNumber: 'desc' },
      select: { invoiceNumber: true },
    });

    const seq = last ? Number(last.invoiceNumber.slice(prefix.length)) + 1 : 1;
    return `${prefix}${String(seq).padStart(4, '0')}`;
  }

  private formatContract(c: {
    id: number;
    organisationId: number;
    ratePerSiteCents: number;
    currency: string;
    billingFrequency: string;
    contractedSiteCount: number | null;
    taxRatePercent: number;
    startDate: Date;
    endDate: Date | null;
    status: ContractStatus;
    paymentTermsDays: number;
    nextInvoiceOn: Date | null;
    notes: string | null;
  }) {
    return {
      id: c.id,
      organisationId: c.organisationId,
      ratePerSite: c.ratePerSiteCents / 100,
      ratePerSiteCents: c.ratePerSiteCents,
      currency: c.currency,
      billingFrequency: c.billingFrequency,
      contractedSiteCount: c.contractedSiteCount,
      taxRatePercent: c.taxRatePercent,
      startDate: c.startDate,
      endDate: c.endDate,
      status: c.status,
      paymentTermsDays: c.paymentTermsDays,
      nextInvoiceOn: c.nextInvoiceOn,
      notes: c.notes,
    };
  }

  private formatInvoice(i: {
    id: number;
    invoiceNumber: string;
    organisationId: number;
    periodStart: Date;
    periodEnd: Date;
    siteCount: number;
    ratePerSiteCents: number;
    subtotalCents: number;
    taxCents: number;
    totalCents: number;
    currency: string;
    status: InvoiceStatus;
    issuedAt: Date | null;
    dueAt: Date | null;
    paidAt: Date | null;
    paymentReference: string | null;
    notes: string | null;
    organisation?: { id: number; name: string; address?: string };
  }) {
    return {
      id: i.id,
      invoiceNumber: i.invoiceNumber,
      organisationId: i.organisationId,
      organisation: i.organisation,
      period: { start: i.periodStart, end: i.periodEnd },
      siteCount: i.siteCount,
      ratePerSite: i.ratePerSiteCents / 100,
      subtotal: i.subtotalCents / 100,
      tax: i.taxCents / 100,
      total: i.totalCents / 100,
      currency: i.currency,
      status: i.status,
      issuedAt: i.issuedAt,
      dueAt: i.dueAt,
      paidAt: i.paidAt,
      paymentReference: i.paymentReference,
      notes: i.notes,
    };
  }
}
