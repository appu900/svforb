import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { EnterpriseModule } from '../enterprise/enterprise.module';
import { MfcInsightsController } from './controllers/mfc-insights.controller';
import { MfcRecordsController } from './controllers/mfc-records.controller';
import { MfcTaxonomyController } from './controllers/mfc-taxonomy.controller';
import { MfcAccessService } from './services/mfc-access.service';
import { MfcClaimHookService } from './services/mfc-claim-hook.service';
import { MfcListingLinkService } from './services/mfc-listing-link.service';
import { MfcInsightsService } from './services/mfc-insights.service';
import { MfcRecordService } from './services/mfc-record.service';

/**
 * Make Food Count — kitchens record everything they did not serve, not only
 * the surplus they offer to a charity.
 *
 * Recorded, listed, claimed and collected stay four separate numbers:
 * recording food never changes a listing, and collecting it never changes what
 * was recorded. See docs/make-food-count/SPEC.md.
 */
@Module({
  imports: [
    AuthModule,
    // For reach resolution and the enterprise snapshot a record carries.
    EnterpriseModule,
  ],
  controllers: [MfcTaxonomyController, MfcRecordsController, MfcInsightsController],
  providers: [
    MfcAccessService, MfcRecordService, MfcListingLinkService,
    MfcClaimHookService, MfcInsightsService,
  ],
  exports: [MfcAccessService, MfcRecordService, MfcListingLinkService, MfcClaimHookService],
})
export class MfcModule {}
