import {
  Body, Controller, Get, Param, ParseIntPipe, Patch, Post, Query, Req, UseGuards,
} from '@nestjs/common';
import { InvoiceStatus } from '@prisma/client';
import { Request } from 'express';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { PlatformAdminGuard } from '../../../common/guards/platform-admin.guard';
import { Jwtpayload } from '../../auth/interface/jwt.interface';
import { SkipSubscriptionCheck } from '../../subscriptions/decorators/skip-subscription-check.decorator';
import {
  CreateContractDto, GenerateInvoiceDto, MarkInvoicePaidDto, UpdateContractDto,
} from '../dto/enterprise.dto';
import { EnterpriseBillingService } from '../services/enterprise-billing.service';

/**
 * Contracts and invoices are administered by Saveful, not the customer, so
 * everything here is platform-admin only. Exempt from the Stripe gate —
 * Enterprise settles offline.
 */
@Controller('enterprise/admin')
@UseGuards(JwtAuthGuard, PlatformAdminGuard)
@SkipSubscriptionCheck()
export class EnterpriseAdminBillingController {
  constructor(private readonly billing: EnterpriseBillingService) {}

  @Post('contracts')
  createContract(@Req() req: Request & { user: Jwtpayload }, @Body() dto: CreateContractDto) {
    return this.billing.createContract(req.user, dto);
  }

  @Get('contracts')
  listContracts() {
    return this.billing.listContracts();
  }

  @Get('contracts/:organisationId')
  getContract(@Param('organisationId', ParseIntPipe) organisationId: number) {
    return this.billing.getContract(organisationId);
  }

  @Patch('contracts/:organisationId')
  updateContract(
    @Param('organisationId', ParseIntPipe) organisationId: number,
    @Body() dto: UpdateContractDto,
  ) {
    return this.billing.updateContract(organisationId, dto);
  }

  /** Raise an invoice now rather than waiting for the cron. */
  @Post('invoices/generate')
  generateInvoice(@Body() dto: GenerateInvoiceDto) {
    return this.billing.generateInvoice(dto);
  }

  @Get('invoices')
  listInvoices(
    @Query('organisationId') organisationId?: string,
    @Query('status') status?: InvoiceStatus,
  ) {
    return this.billing.listInvoices({
      organisationId: organisationId ? Number(organisationId) : undefined,
      status,
    });
  }

  @Get('invoices/:id')
  getInvoice(@Param('id', ParseIntPipe) id: number) {
    return this.billing.getInvoice(id);
  }

  /** Records an offline payment — bank transfer reference, cheque, etc. */
  @Post('invoices/:id/mark-paid')
  markPaid(
    @Req() req: Request & { user: Jwtpayload },
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: MarkInvoicePaidDto,
  ) {
    return this.billing.markInvoicePaid(req.user, id, dto);
  }

  @Post('invoices/:id/cancel')
  cancelInvoice(@Param('id', ParseIntPipe) id: number, @Body('reason') reason?: string) {
    return this.billing.cancelInvoice(id, reason);
  }
}

/** The Enterprise's own read-only view of its invoices. */
@Controller('enterprise/invoices')
@UseGuards(JwtAuthGuard)
@SkipSubscriptionCheck()
export class EnterpriseInvoiceController {
  constructor(private readonly billing: EnterpriseBillingService) {}

  @Get()
  listMine(@Req() req: Request & { user: Jwtpayload }) {
    return this.billing.listMyInvoices(req.user);
  }
}
