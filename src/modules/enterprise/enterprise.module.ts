import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { EnterpriseAuditService } from './services/enterprise-audit.service';
import { EnterpriseBillingService } from './services/enterprise-billing.service';
import { EnterpriseImpactService } from './services/enterprise-impact.service';
import { EnterpriseInvitationService } from './services/enterprise-invitation.service';
import { EnterpriseProfileService } from './services/enterprise-profile.service';
import { EnterpriseProvisioningService } from './services/enterprise-provisioning.service';
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
import { EnterpriseActivationController } from './controllers/enterprise-activation.controller';
import { EnterpriseProfileController } from './controllers/enterprise-profile.controller';
import { EnterpriseProvisioningController } from './controllers/enterprise-provisioning.controller';
import {
  EnterpriseInviteController,
  EnterpriseUserController,
} from './controllers/enterprise-user.controller';
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
    EnterpriseInviteController,
    EnterpriseProvisioningController,
    EnterpriseProfileController,
    // Unauthenticated by design — the invitation token is the credential.
    EnterpriseActivationController,
  ],
  providers: [
    EnterpriseScopeService,
    EnterpriseStructureService,
    EnterpriseReportingService,
    EnterpriseBillingService,
    EnterpriseUserService,
    EnterpriseAuditService,
    EnterpriseImpactService,
    EnterpriseInvitationService,
    EnterpriseProvisioningService,
    EnterpriseProfileService,
    EnterpriseQueueService,
    EnterpriseWorker,
  ],
  exports: [
    EnterpriseScopeService,
    EnterpriseAuditService,
    EnterpriseImpactService,
    EnterpriseInvitationService,
  ],
})
export class EnterpriseModule {}
