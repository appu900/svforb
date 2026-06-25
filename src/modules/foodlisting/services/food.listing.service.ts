import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ListingStatus } from '@prisma/client';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { Jwtpayload } from '../../auth/interface/jwt.interface';
import { S3Service } from '../../../uploads/s3/s3.service';
import { ListingQueueService } from '../queues/listing.queue.service';
import { FoodListingCacheManager } from '../cache/food.listing.cache';
import { CreateFoodListingDto } from '../dto/food.listing.dto';

const PHOTO_FOLDER = 'food-listing-photos';
const DEFAULT_LIMIT = 20;


@Injectable()
export class FoodListingService {
  private readonly logger = new Logger(FoodListingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: FoodListingCacheManager,
    private readonly s3: S3Service,
    private readonly listingQueue: ListingQueueService,
  ) {}

  async createListing(
    caller: Jwtpayload,
    dto: CreateFoodListingDto,
    photos?: Express.Multer.File[],
  ) {
    if (!dto.foodItems?.length) {
      throw new BadRequestException('At least one food item is required');
    }

    const site = await this.prisma.site.findFirst({
      where: { id: dto.siteId, organisationId: caller.orgId, isActive: true },
    });
    if (!site)
      throw new NotFoundException('Site not found in your organisation');

    const uploadedUrls =
      photos?.length
        ? await Promise.all(photos.map((f) => this.s3.uploadFile(f, PHOTO_FOLDER)))
        : (dto.photoUrls ?? []);

    const totalQtyKg = dto.foodItems.reduce((sum, i) => sum + i.totalQtyKg, 0);

    const listing = await this.prisma.$transaction(async (tx) => {
      const created = await tx.foodListing.create({
        data: {
          siteId: dto.siteId,
          organisationId: caller.orgId!,
          listingType: dto.listingType,
          totalQtyKg,
          remainingQtyKg: totalQtyKg,
          pickupAddress: dto.pickupAddress,
          pickupPostcode: dto.pickupPostcode,
          pickupLat: dto.pickupLat,
          pickupLng: dto.pickupLng,
          bestBefore: new Date(dto.bestBefore),
          pickupFromTime: dto.pickupFromTime
            ? new Date(dto.pickupFromTime)
            : null,
          pickupByTime: dto.pickupByTime ? new Date(dto.pickupByTime) : null,
          needsRefrigeration: dto.needsRefrigeration ?? false,
          needsAmbient: dto.needsAmbient ?? false,
          needsFreezer: dto.needsFreezer ?? false,
          needsReheating: dto.needsReheating ?? false,
          isSafeForDonation: dto.isSafeForDonation ?? true,
          allergens: dto.allergens ?? [],
          photoUrls: uploadedUrls,
        },
      });

      await tx.foodItem.createMany({
        data: dto.foodItems.map((item) => ({
          listingId: created.id,
          name: item.name,
          totalQtyKg: item.totalQtyKg,
          remainingQtyKg: item.totalQtyKg,
          unit: item.unit,
          category: item.category,
        })),
      });

      return tx.foodListing.findUnique({
        where: { id: created.id },
        include: { foodItems: true },
      });
    });
    const listingActivity = await this.prisma.listingActivity.create({
      data:{
        actorOrgId:site.organisationId,
        listingId:listing!.id,
        eventType:'listing created',
        message:'Food listing created looking for charities',
      }
    })

    await Promise.all([
      this.cache.invalidateOrgPage1(caller.orgId!),
      this.cache.invalidateRecentPage1(),
    ]);

    await Promise.all([
      this.listingQueue.enqueueNewListing({
        listingId: listing!.id,
        siteId: dto.siteId,
        listingType: dto.listingType,
        pickupAddress: dto.pickupAddress,
        businessName: site.organisationName,
        totalQtyKg,
        bestBefore: dto.bestBefore,
      }),
      this.listingQueue.enqueueListingExpiry(listing!.id),
    ]);

    this.logger.log(
      `Listing created: id=${listing!.id} org=${caller.orgId} totalKg=${totalQtyKg}`,
    );

    return listing;
  }

  async getAllListingOfSiteID(siteId:number,callerUserId:number){
    const callerUserDetails = await this.prisma.user.findUnique({where:{id:callerUserId}})
    if(!callerUserDetails) throw new UnauthorizedException("user has not access for the data")
    const hasSiteAccess = await this.prisma.siteAccess.findFirst({ where: { siteId: siteId, userId: callerUserDetails.id } })
    if (!hasSiteAccess) throw new UnauthorizedException("access denied")
    const allFoodListings = await this.prisma.foodListing.findMany({
      where: {
        siteId:siteId
      },
      include:{
        foodItems:true
      }
    })
    return allFoodListings;
  }
  async getOrgListings(
    orgId: number,
    page = 1,
    limit = DEFAULT_LIMIT,
    status?: ListingStatus,
  ) {
    const cacheKey = status ? null : await this.cache.getOrgPage(orgId, page);
    if (cacheKey) return cacheKey;

    const skip = (page - 1) * limit;

    const [listings, total] = await Promise.all([
      this.prisma.foodListing.findMany({
        where: { organisationId: orgId, ...(status ? { status } : {}) },
        include: { foodItems: true, _count: { select: { foodClaims: true } } },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.foodListing.count({
        where: { organisationId: orgId, ...(status ? { status } : {}) },
      }),
    ]);

    const result = {
      listings,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };

    if (!status) await this.cache.setOrgPage(orgId, page, result);

    return result;
  }

  async getListingById(id: number) {
    const cached = await this.cache.getListing(id);
    if (cached) return cached;

    const listing = await this.prisma.foodListing.findUnique({
      where: { id },
      include: {
        foodItems: true,
        site: {
          select: {
            organisationName: true,
            address: true,
            contactEmail: true,
            contactMobile: true,
          },
        },
        organisation: {
          select: { id: true, name: true, logoUrl: true, ratingAvg: true },
        },
        foodClaims: {
          where: { status: { not: 'CANCELLED' } },
          select: {
            id: true,
            status: true,
            claimMode: true,
            createdAt: true,
          },
        },
      },
    });

    if (!listing) throw new NotFoundException('Listing not found');

    await this.cache.setListing(id, listing);
    return listing;
  }

  async getRecentListings(siteId: number, page = 1, limit = DEFAULT_LIMIT) {
    console.log("this is siteID",siteId)
    const skip = (page - 1) * limit;

    const [listings, total] = await Promise.all([
      this.prisma.foodListing.findMany({
        where: { siteId },
        include: {
          foodItems: {
            select: { id: true, name: true, remainingQtyKg: true, unit: true },
          },
          organisation: {
            select: { id: true, name: true, logoUrl: true, ratingAvg: true },
          },
          site: { select: { id: true, address: true, postcode: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.foodListing.count({ where: { siteId } }),
    ]);

    return { listings, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async cancelListing(caller: Jwtpayload, id: number) {
    const listing = await this.prisma.foodListing.findFirst({
      where: { id, organisationId: caller.orgId },
    });
    if (!listing) throw new NotFoundException('Listing not found');
    if (listing.status === ListingStatus.CLAIMED) {
      throw new ForbiddenException('Cannot cancel a fully claimed listing');
    }

    await this.prisma.foodListing.update({
      where: { id },
      data: { status: ListingStatus.CANCELLED },
    });

    await Promise.all([
      this.cache.delListing(id),
      this.cache.invalidateOrgPage1(caller.orgId!),
      this.cache.invalidateRecentPage1(),
    ]);

    return { message: 'Listing cancelled' };
  }
}
