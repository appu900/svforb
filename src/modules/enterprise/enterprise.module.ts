import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { EnterpriseBillingService } from './services/enterprise-billing.service';
import { EnterpriseReportingService } from './services/enterprise-reporting.service';
import { EnterpriseScopeService } from './services/enterprise-scope.service';
import { EnterpriseStructureService } from './services/enterprise-structure.service';
import { EnterpriseUserService } from './services/enterprise-user.service';
import {
  EnterpriseAdminBillingController,
  EnterpriseInvoiceController,
} from './controllers/enterprise-billing.controller';
import { EnterpriseReportingController } from './controllers/enterprise-reporting.controller';
import { EnterpriseStructureController } from './controllers/enterprise-structure.controller';
import { EnterpriseUserController } from './controllers/enterprise-user.controller';
import { ENTERPRISE_QUEUE, EnterpriseQueueService } from './queues/enterprise.queue.service';
import { EnterpriseWorker } from './workers/enterprise.worker';

@Module({
  imports: [AuthModule, BullModule.registerQueue({ name: ENTERPRISE_QUEUE })],
  controllers: [
    EnterpriseStructureController,
    EnterpriseReportingController,
    EnterpriseAdminBillingController,
    EnterpriseInvoiceController,
    EnterpriseUserController,
  ],
  providers: [
    EnterpriseScopeService,
    EnterpriseStructureService,
    EnterpriseReportingService,
    EnterpriseBillingService,
    EnterpriseUserService,
    EnterpriseQueueService,
    EnterpriseWorker,
  ],
  exports: [EnterpriseScopeService],
})
export class EnterpriseModule {}
