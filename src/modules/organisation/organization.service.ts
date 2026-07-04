import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { OrgRole, OrgType, Region } from '@prisma/client';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { S3Service } from '../../uploads/s3/s3.service';
import { Jwtpayload } from '../auth/interface/jwt.interface';
import { ProximityService } from '../psearch/psearch.service';
import { RedisGeoSearchService } from '../redis-geo-search/redis.geosearch.service';
import { UpdateLocationDto, UpdateOrganizationDto } from './dto/update.location.dto';

const BUSINESS_TYPES: OrgType[] = [OrgType.BUSINESS_SINGLE, OrgType.BUSINESS_MULTI];
const CHARITY_SINGLE_TYPES: OrgType[] = [OrgType.CHARITY, OrgType.CHARITY_SINGLE];
const SITE_COORDS_TYPES: OrgType[] = [
  OrgType.FARMER_CONSUMER,
  OrgType.BUSINESS_SINGLE,
  OrgType.CHARITY_SINGLE,
  OrgType.CHARITY,
];
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

  async updateOrganizationLocation(dto: UpdateLocationDto, organizationId: number) {
    const lat = Number(dto.latitude);
    const lng = Number(dto.longitude);
    this.validateCoords(lat, lng);

    const organization = await this.prisma.organisation.findUnique({
      where: { id: organizationId },
      select: { organizationType: true, region: true },
    });
    if (!organization) {
      throw new NotFoundException('Organization not found');
    }

    await this.prisma.organisation.update({
      where: { id: organizationId },
      data: { longitude: lng, latitude: lat },
    });

    await this.prisma.$executeRaw`
      UPDATE organisations
      SET location = ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography
      WHERE id = ${organizationId}
    `;

    let sites: { id: number }[] = [];
    if (SITE_COORDS_TYPES.includes(organization.organizationType)) {
      await this.prisma.site.updateMany({
        where: { organisationId: organizationId },
        data: { latitude: lat, longitude: lng },
      });
      sites = await this.prisma.site.findMany({
        where: { organisationId: organizationId },
        select: { id: true },
      });
      await Promise.all(
        sites.map((site) => this.proximityService.syncSiteLocation(site.id, lat, lng)),
      );
    }

    const { organizationType, region } = organization;
    if (region) {
      await this.reindexGeo(organizationId, organizationType, region, lat, lng, sites);
    }

    this.logger.log(
      `Location updated org=${organizationId} type=${organizationType} sites=${sites.map((s) => s.id).join(',') || 'none'}`,
    );

    return {
      message: 'Location updated successfully',
      organizationId,
      latitude: lat,
      longitude: lng,
      siteIds: sites.map((s) => s.id),
    };
  }

  private async reindexGeo(
    organizationId: number,
    organizationType: OrgType,
    region: Region,
    lat: number,
    lng: number,
    sites: { id: number }[],
  ) {
    if (BUSINESS_TYPES.includes(organizationType)) {
      await this.geoSearch.indexBusiness(organizationId, lat, lng, region);
      return;
    }

    if (CHARITY_SINGLE_TYPES.includes(organizationType)) {
      await this.geoSearch.indexCharity(organizationId, lat, lng, region);
      await Promise.all(
        sites.map((site) => this.geoSearch.indexCharitySite(site.id, lat, lng, region)),
      );
      return;
    }

    if (organizationType === OrgType.FARMER_CONSUMER) {
      await this.geoSearch.indexFarmerConsumer(organizationId, lat, lng, region);
      await Promise.all(
        sites.map((site) =>
          this.geoSearch.indexFarmerConsumerSite(site.id, lat, lng, region),
        ),
      );
    }
  }

  private validateCoords(lat: number, lng: number) {
    if (
      Number.isNaN(lat) ||
      Number.isNaN(lng) ||
      lat < -90 ||
      lat > 90 ||
      lng < -180 ||
      lng > 180 ||
      (lat === 0 && lng === 0)
    ) {
      throw new BadRequestException(
        'Invalid coordinates. Latitude must be between -90 and 90 and longitude between -180 and 180.',
      );
    }
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
