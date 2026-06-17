import { Logger, Injectable, NotFoundException } from '@nestjs/common';
import { OrgType } from '@prisma/client';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { ProximityService } from '../psearch/psearch.service';
import { RedisGeoSearchService } from '../redis-geo-search/redis.geosearch.service';

const BUSINESS_TYPES: OrgType[] = [OrgType.BUSINESS_SINGLE, OrgType.BUSINESS_MULTI];
const CHARITY_SINGLE_TYPES: OrgType[] = [OrgType.CHARITY, OrgType.CHARITY_SINGLE];

@Injectable()
export class OrganisationService {
  private readonly logger = new Logger(OrganisationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly proximityService: ProximityService,
    private readonly geoSearch: RedisGeoSearchService,
  ) {}

  async updateOrganizationLocation(dto: any, organizationId: number) {
    const organization = await this.prisma.organisation.findUnique({
      where: { id: organizationId },
      select: { longitude: true, latitude: true, organizationType: true, region: true },
    });
    if (!organization) {
      return new NotFoundException('Organization not found');
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
}
