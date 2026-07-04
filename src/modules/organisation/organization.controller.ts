import { Body, Controller, Logger, Param, Patch, Post, Req, UploadedFile, UseGuards, UseInterceptors, ParseIntPipe } from "@nestjs/common";
import { FileInterceptor } from '@nestjs/platform-express';
import { Request } from 'express';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { Jwtpayload } from '../auth/interface/jwt.interface';
import { OrganisationService } from "./organization.service";
import { UpdateLocationDto, UpdateOrganizationDto } from "./dto/update.location.dto";


//bhAi ki api
@Controller('organization')
export class OrganizationController {
    private readonly logger = new Logger(OrganizationController.name)
    constructor(private readonly organizationService: OrganisationService) { }

    @Patch('ccordinates/:organizationId')
    async updateOrganizationLocation(@Param('organizationId') organizationId: number, @Body() dto: UpdateLocationDto) {
        return await this.organizationService.updateOrganizationLocation(dto, organizationId);
    }

    @Patch(':orgId')
    @UseGuards(JwtAuthGuard)
    @UseInterceptors(FileInterceptor('logo'))
    updateOrganization(
        @Req() req: Request & { user: Jwtpayload },
        @Param('orgId', ParseIntPipe) orgId: number,
        @Body() dto: UpdateOrganizationDto,
        @UploadedFile() logo?: Express.Multer.File,
    ) {
        return this.organizationService.updateOrganization(req.user, orgId, dto, logo);
    }
}
