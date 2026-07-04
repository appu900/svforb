import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { OrgRole, OrgType } from '@prisma/client';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { S3Service } from '../../uploads/s3/s3.service';
import { Jwtpayload } from '../auth/interface/jwt.interface';
import { ProximityService } from '../psearch/psearch.service';
import { RedisGeoSearchService } from '../redis-geo-search/redis.geosearch.service';
import { UpdateOrganizationDto } from './dto/update.location.dto';

const BUSINESS_TYPES: OrgType[] = [OrgType.BUSINESS_SINGLE, OrgType.BUSINESS_MULTI];
const CHARITY_SINGLE_TYPES: OrgType[] = [OrgType.CHARITY, OrgType.CHARITY_SINGLE];
const LOGO_FOLDER = 'buisiness2logo';

@Injectable()
export class OrganisationService {
  private readonly logger = new Logger(OrganisationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly proximityService: ProximityService,
    private readonly geoSearch: RedisGeoSearchService,
    private readonly s3: S3Service,
  ) {}

  async updateOrganizationLocation(dto: any, organizationId: number) {
    const organization = await this.prisma.organisation.findUnique({
      where: { id: organizationId },
      select: { longitude: true, latitude: true, organizationType: true, region: true },
    });
    if (!organization) {
      throw new NotFoundException('Organization not found');
    }

    const updatedOrganization = await this.prisma.organisation.update({
      where: { id: organizationId },
      data: { longitude: dto.longitude, latitude: dto.latitude },
    });

    await this.proximityService.syncOrganisationLocation();

    const { region } = organization;
    const lat: number = dto.latitude;
    const lng: number = dto.longitude;

    if (region && lat && lng) {
      if (BUSINESS_TYPES.includes(organization.organizationType)) {
        await this.geoSearch.indexBusiness(organizationId, lat, lng, region);
      } else if (CHARITY_SINGLE_TYPES.includes(organization.organizationType)) {
        await this.geoSearch.indexCharity(organizationId, lat, lng, region);
      }
    }

    return updatedOrganization;
  }

  async updateOrganization(
    caller: Jwtpayload,
    organizationId: number,
    dto: UpdateOrganizationDto,
    logo?: Express.Multer.File,
  ) {
    if (!caller.orgId || caller.orgId !== organizationId) {
      throw new ForbiddenException('You can only update your own organisation');
    }
    if (
      caller.orgRole !== OrgRole.SUPER_ADMIN &&
      caller.orgRole !== OrgRole.ORG_ADMIN
    ) {
      throw new ForbiddenException('Only organisation admins can update profile details');
    }

    const organisation = await this.prisma.organisation.findUnique({
      where: { id: organizationId },
    });
    if (!organisation) throw new NotFoundException('Organisation not found');

    let logoUrl: string | undefined;
    if (logo) {
      logoUrl = await this.s3.uploadFile(logo, LOGO_FOLDER);
    }

    const updated = await this.prisma.organisation.update({
      where: { id: organizationId },
      data: {
        ...(dto.brandName !== undefined && { brandName: dto.brandName }),
        ...(dto.registrationNumber !== undefined && {
          registrationNumber: dto.registrationNumber,
        }),
        ...(dto.venueType !== undefined && { venueType: dto.venueType }),
        ...(logoUrl && { logoUrl }),
      },
    });

    this.logger.log(`Organisation ${organizationId} updated by user ${caller.sub}`);

    return {
      message: 'Organisation updated successfully',
      organisation: {
        id: updated.id,
        name: updated.name,
        type: updated.organizationType,
        brandName: updated.brandName,
        registrationNumber: updated.registrationNumber,
        venueType: updated.venueType,
        logoUrl: updated.logoUrl,
        address: updated.address,
      },
    };
  }
}
