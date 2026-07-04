import { Module } from '@nestjs/common';
import { OrganisationService } from './organization.service';
import { ProximityModule } from '../psearch/psearch.module';
import { OrganizationController } from './organization.controller';
import { RedisGeoSearchModule } from '../redis-geo-search/redis-geo-search.module';
import { S3Module } from '../../uploads/s3/s3.module';

@Module({
  imports: [ProximityModule, RedisGeoSearchModule, S3Module],
  controllers: [OrganizationController],
  providers: [OrganisationService],
  exports: [OrganisationService],
})
export class OrganizationModule {}