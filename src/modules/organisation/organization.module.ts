


import {Module} from "@nestjs/common"
import { OrganisationService } from "./organization.service";


@Module({
  imports: [],
  controllers: [],
  providers: [OrganisationService],
  exports: [OrganisationService],
})
export class OrganizationModule{}