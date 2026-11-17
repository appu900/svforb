import { Module } from '@nestjs/common';
import { GatewayModule } from '../../gateway/gateway.module';
import { DriversModule } from '../drivers/drivers.module';
import { ClaimsController } from './controller/claims.controller';
import { ClaimsService } from './services/claims.service';
import { ClaimsCacheManager } from './cache/claims.cachemanager';
import { EnterpriseModule } from '../enterprise/enterprise.module';
import { MfcModule } from '../make-food-count/mfc.module';

@Module({
  imports: [EnterpriseModule, GatewayModule, DriversModule, MfcModule],
  controllers: [ClaimsController],
  providers: [ClaimsService, ClaimsCacheManager],
  exports: [ClaimsService, ClaimsCacheManager],
})
export class ClaimsModule {}
