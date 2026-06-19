import { Body, Controller, Logger, Param, Patch, Post } from "@nestjs/common";
import { OrganisationService } from "./organization.service";
import { UpdateLocationDto } from "./dto/update.location.dto";


//bhAi ki api
@Controller('organization')
export class OrganizationController {
    private readonly logger = new Logger(OrganizationController.name)
    constructor(private readonly organizationService: OrganisationService) { }

    @Patch('ccordinates/:organizationId')
    async updateOrganizationLocation(@Param('organizationId') organizationId: number, @Body() dto: UpdateLocationDto) {
        return await this.organizationService.updateOrganizationLocation(dto, organizationId);
    }
}