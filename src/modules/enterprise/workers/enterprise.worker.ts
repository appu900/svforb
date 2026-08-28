import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { ContractStatus, InvoiceStatus } from '@prisma/client';
import { Job } from 'bullmq';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { ENTERPRISE_JOBS, ENTERPRISE_QUEUE } from '../queues/enterprise.queue.service';
import { EnterpriseBillingService } from '../services/enterprise-billing.service';
import { EnterpriseInvitationService } from '../services/enterprise-invitation.service';

@Processor(ENTERPRISE_QUEUE)
export class EnterpriseWorker extends WorkerHost {
  private readonly logger = new Logger(EnterpriseWorker.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly billing: EnterpriseBillingService,
    private readonly invitations: EnterpriseInvitationService,
  ) {
    super();
  }

  async process(job: Job): Promise<void> {
    switch (job.name) {
      case ENTERPRISE_JOBS.GENERATE_INVOICES:
        await this.generateDueInvoices();
        break;
      case ENTERPRISE_JOBS.MARK_OVERDUE:
        await this.markOverdue();
        await this.billing.expireLapsedContracts();
        // Lapsed activation links stop reading as "Invited" in the user list.
        await this.invitations.expireLapsedInvitations();
        break;
      default:
        this.logger.warn(`Unhandled enterprise job: ${job.name}`);
    }
  }

  /** Raises an invoice for every active contract whose anchor has arrived. */
  private async generateDueInvoices() {
    const now = new Date();

    const due = await this.prisma.enterpriseContract.findMany({
      where: {
        status: ContractStatus.ACTIVE,
        nextInvoiceOn: { lte: now },
      },
      select: { id: true, organisationId: true },
    });

    if (!due.length) return;

    let created = 0;
    for (const contract of due) {
      try {
        const result = await this.billing.generateInvoiceForContract(contract.id);
        if (result.created) created++;
        else {
          this.logger.debug(
            `Contract ${contract.id} skipped: ${result.reason}`,
          );
        }
      } catch (err) {
        // One bad contract must not stop the rest of the sweep.
        this.logger.error(
          `Invoice generation failed for contract ${contract.id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    this.logger.log(`Invoice sweep: ${created} raised from ${due.length} due contract(s)`);
  }

  /** Flags issued invoices whose due date has passed. */
  private async markOverdue() {
    const result = await this.prisma.enterpriseInvoice.updateMany({
      where: { status: InvoiceStatus.ISSUED, dueAt: { lt: new Date() } },
      data: { status: InvoiceStatus.OVERDUE },
    });
    if (result.count) this.logger.log(`Marked ${result.count} invoice(s) overdue`);
  }
}
