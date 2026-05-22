


import {Module} from "@nestjs/common"
import { OrganisationService } from "./organization.service";
import { ProximityModule } from "../psearch/psearch.module";


@Module({
  imports: [ProximityModule],
  controllers: [],
  providers: [OrganisationService],
  exports: [OrganisationService],
})
export class OrganizationModule{}