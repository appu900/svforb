import { Module } from '@nestjs/common';
import { DriversModule } from '../modules/drivers/drivers.module';
import { ListingGateway } from './listing.gateway';

@Module({
  imports: [DriversModule],
  providers: [ListingGateway],
  exports: [ListingGateway],
})
export class GatewayModule {}
