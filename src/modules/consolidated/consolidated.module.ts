import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { EnterpriseModule } from '../enterprise/enterprise.module';
import { FoodListingModule } from '../foodlisting/foodlisting.module';
import { NotificationModule } from '../notifications/notification.module';
import { ConsolidatedEnabledGuard } from './consolidated-enabled.guard';
import { ConsolidatedAccessController } from './controllers/consolidated-access.controller';
import { ConsolidatedCharityController } from './controllers/consolidated-charity.controller';
import { ConsolidatedCollectionsController } from './controllers/consolidated-collections.controller';
import { ConsolidatedContributionsController } from './controllers/consolidated-contributions.controller';
import { ConsolidatedGroupsController } from './controllers/consolidated-groups.controller';
import { ConsolidatedReportsController } from './controllers/consolidated-reports.controller';
import { CONSOLIDATED_QUEUE, ConsolidatedQueueService } from './queues/consolidated.queue.service';
import { ConsolidatedAccessService } from './services/consolidated-access.service';
import { ConsolidatedAuditService } from './services/consolidated-audit.service';
import { ConsolidatedCollectionService } from './services/consolidated-collection.service';
import { ConsolidatedCompletionService } from './services/consolidated-completion.service';
import { ConsolidatedContributionService } from './services/consolidated-contribution.service';
import { ConsolidatedGroupService } from './services/consolidated-group.service';
import { ConsolidatedNotifierService } from './services/consolidated-notifier.service';
import { ConsolidatedPublishService } from './services/consolidated-publish.service';
import { ConsolidatedReceiptService } from './services/consolidated-receipt.service';
import { ConsolidatedReportService } from './services/consolidated-report.service';
import { ConsolidatedScheduleService } from './services/consolidated-schedule.service';
import { ConsolidatedWorker } from './workers/consolidated.worker';

/**
 * Consolidated Collections — several sites in one venue contribute to a shared
 * collection point, the charity sees and claims one listing, and every site
 * keeps its own traceable record. See docs/consolidated-collections/SPEC.md.
 */
@Module({
  imports: [
    AuthModule,
    NotificationModule,
    // For the Enterprise classification snapshot a contribution listing carries.
    EnterpriseModule,
    // For createListingRecord — a contribution is an ordinary listing, written
    // through the same code path so the two can never drift apart.
    FoodListingModule,
    BullModule.registerQueue({ name: CONSOLIDATED_QUEUE }),
  ],
  controllers: [
    ConsolidatedAccessController,
    ConsolidatedGroupsController,
    ConsolidatedCollectionsController,
    ConsolidatedContributionsController,
    ConsolidatedCharityController,
    ConsolidatedReportsController,
  ],
  providers: [
    ConsolidatedEnabledGuard,
    ConsolidatedAccessService,
    ConsolidatedAuditService,
    ConsolidatedGroupService,
    ConsolidatedScheduleService,
    ConsolidatedCollectionService,
    ConsolidatedContributionService,
    ConsolidatedReceiptService,
    ConsolidatedPublishService,
    ConsolidatedCompletionService,
    ConsolidatedNotifierService,
    ConsolidatedReportService,
    ConsolidatedQueueService,
    ConsolidatedWorker,
  ],
  exports: [ConsolidatedAccessService],
})
export class ConsolidatedModule {}
