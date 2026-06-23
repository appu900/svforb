import { Module } from '@nestjs/common';
import { GatewayModule } from '../../gateway/gateway.module';
import { DriversModule } from '../drivers/drivers.module';
import { ClaimsService } from './services/claims.service';
import { ClaimsCacheManager } from './cache/claims.cachemanager';

@Module({
  imports: [GatewayModule, DriversModule],
  providers: [ClaimsService, ClaimsCacheManager],
  exports: [ClaimsService],
})
export class ClaimsModule {}
