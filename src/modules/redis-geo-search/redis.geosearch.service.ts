import { Injectable, Logger } from '@nestjs/common';
import { Region } from '@prisma/client';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { RedisService } from '../../infra/redis/redis.service';

interface GeoResult {
  member: string;
  distanceKm: number;
  coords: { lat: number; lng: number };
}

@Injectable()
export class RedisGeoSearchService {
  private readonly logger = new Logger(RedisGeoSearchService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  private charityKey(region: Region) {
    return `geo:charities:${region}`;
  }

  private charitySiteKey(region: Region) {
    return `geo:charity-sites:${region}`;
  }

  private businessKey(region: Region) {
    return `geo:businesses:${region}`;
  }

  async indexCharity(orgId: number, lat: number, lng: number, region: Region) {
    await this.redis.getClient().geoadd(this.charityKey(region), lng, lat, String(orgId));
    this.logger.log(`Indexed charity org=${orgId} region=${region}`);
  }

  async indexCharitySite(siteId: number, lat: number, lng: number, region: Region) {
    await this.redis.getClient().geoadd(this.charitySiteKey(region), lng, lat, String(siteId));
    this.logger.log(`Indexed charity site=${siteId} region=${region}`);
  }

  async indexBusiness(orgId: number, lat: number, lng: number, region: Region) {
    await this.redis.getClient().geoadd(this.businessKey(region), lng, lat, String(orgId));
    this.logger.log(`Indexed business org=${orgId} region=${region}`);
  }

  async removeCharity(orgId: number, region: Region) {
    await this.redis.getClient().zrem(this.charityKey(region), String(orgId));
  }

  async removeCharitySite(siteId: number, region: Region) {
    await this.redis.getClient().zrem(this.charitySiteKey(region), String(siteId));
  }

  async searchNearbyCharities(
    lat: number,
    lng: number,
    radiusKm: number,
    region: Region,
  ) {
    const client = this.redis.getClient();

    const geoSearchArgs = (key: string) => [
      key,
      'FROMLONLAT', String(lng), String(lat),
      'BYRADIUS', String(radiusKm), 'km',
      'ASC', 'WITHCOORD', 'WITHDIST', 'COUNT', '50',
    ] as const;

    const [rawOrgs, rawSites] = (await Promise.all([
      client.call('GEOSEARCH', ...geoSearchArgs(this.charityKey(region))),
      client.call('GEOSEARCH', ...geoSearchArgs(this.charitySiteKey(region))),
    ])) as [any[][], any[][]];

    const parseGeoResults = (raw: any[][]): GeoResult[] =>
      (raw || []).map((r) => ({
        member: String(r[0]),
        distanceKm: parseFloat(r[1]),
        coords: { lat: parseFloat(r[2][1]), lng: parseFloat(r[2][0]) },
      }));

    const orgGeo = parseGeoResults(rawOrgs);
    const siteGeo = parseGeoResults(rawSites);

    const [orgs, sites] = await Promise.all([
      this.prisma.organisation.findMany({
        where: { id: { in: orgGeo.map((o) => Number(o.member)) } },
        select: {
          id: true,
          name: true,
          organizationType: true,
          logoUrl: true,
          address: true,
          ratingAvg: true,
          ratingCount: true,
        },
      }),
      // Site has no Prisma relation to Organisation, fetch separately below
      this.prisma.site.findMany({
        where: {
          id: { in: siteGeo.map((s) => Number(s.member)) },
          isActive: true,
        },
        select: {
          id: true,
          organisationId: true,
          organisationName: true,
          address: true,
        },
      }),
    ]);

    // Fetch the parent orgs for all matched sites
    const siteOrgIds = [...new Set(sites.map((s) => s.organisationId))];
    const siteOrgs = await this.prisma.organisation.findMany({
      where: { id: { in: siteOrgIds } },
      select: {
        id: true,
        name: true,
        organizationType: true,
        logoUrl: true,
        ratingAvg: true,
        ratingCount: true,
      },
    });

    const orgMap = new Map(orgs.map((o) => [o.id, o]));
    const siteMap = new Map(sites.map((s) => [s.id, s]));
    const siteOrgMap = new Map(siteOrgs.map((o) => [o.id, o]));

    const charityResults = orgGeo
      .filter((o) => orgMap.has(Number(o.member)))
      .map((o) => {
        const org = orgMap.get(Number(o.member))!;
        return {
          orgId: org.id,
          orgName: org.name,
          orgType: org.organizationType,
          logoUrl: org.logoUrl,
          address: org.address,
          siteId: null as number | null,
          siteName: null as string | null,
          distanceKm: o.distanceKm,
          coordinates: o.coords,
          rating: { avg: org.ratingAvg, count: org.ratingCount },
        };
      });

    const siteResults = siteGeo
      .filter((s) => siteMap.has(Number(s.member)))
      .map((s) => {
        const site = siteMap.get(Number(s.member))!;
        const org = siteOrgMap.get(site.organisationId);
        if (!org) return null;
        return {
          orgId: site.organisationId,
          orgName: org.name,
          orgType: org.organizationType,
          logoUrl: org.logoUrl,
          address: site.address,
          siteId: site.id,
          siteName: site.organisationName,
          distanceKm: s.distanceKm,
          coordinates: s.coords,
          rating: { avg: org.ratingAvg, count: org.ratingCount },
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);

    const charities = [...charityResults, ...siteResults].sort(
      (a, b) => a.distanceKm - b.distanceKm,
    );

    return {
      searchCoordinates: { lat, lng },
      radiusKm,
      region,
      total: charities.length,
      charities,
    };
  }
}
