


import {Module} from "@nestjs/common"
import { OrganisationService } from "./organization.service";
import { ProximityModule } from "../psearch/psearch.module";
import { OrganizationController } from "./organization.controller";


@Module({
  imports: [ProximityModule],
  controllers: [OrganizationController],
  providers: [OrganisationService],
  exports: [OrganisationService],
})
export class OrganizationModule{}