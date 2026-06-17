
import { Module } from "@nestjs/common"
import { OrganisationService } from "./organization.service";
import { ProximityModule } from "../psearch/psearch.module";
import { OrganizationController } from "./organization.controller";
import { RedisGeoSearchModule } from "../redis-geo-search/redis-geo-search.module";

@Module({
  imports: [ProximityModule, RedisGeoSearchModule],
  controllers: [OrganizationController],
  providers: [OrganisationService],
  exports: [OrganisationService],
})
export class OrganizationModule {}