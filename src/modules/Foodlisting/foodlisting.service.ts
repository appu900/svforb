import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { PushQueueService } from '../notifications/queues/push.queue.service';
import {
  CreateListingDto,
  FoodItemDto,
  GetListingsQueryDto,
  RelistDto,
  UpdateListingDto,
} from './dto/food.listing.dto';
import { ProximityService } from '../psearch/psearch.service';

@Injectable()
export class FoodListingService {
  private readonly logger = new Logger(FoodListingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly proximity: ProximityService,
    private readonly pushQueue:PushQueueService
  ) {}

  async createListing(organisationId: number, dto: CreateListingDto) {
    const site = await this.prisma.site.findFirst({
      where: { id: dto.siteId, organisationId },
    });

    if (!site) {
      throw new NotFoundException('Site not found or does not belong to your organisation');
    }

    if (site.latitude == null || site.longitude == null) {
      throw new BadRequestException(
        'Site has no coordinates set. Update the site location before creating a listing.',
      );
    }

    const organisation = await this.prisma.organisation.findUnique({ where: { id: site.organisationId } });
    if (!organisation) throw new BadRequestException('Something went wrong');

    const totalQtyKg = this.sumTotal(dto.foodItems);
    const remainingQtyKg = this.sumRemaining(dto.foodItems);

    const listing = await this.prisma.foodListing.create({
      data: {
        siteId: dto.siteId,
        organisationId,
        foodItems: dto.foodItems as any,
        totalQtyKg,
        remainingQtyKg,
        pickupAddress: dto.pickupAddress,
        pickupPostcode: dto.pickupPostcode,
        pickupLat: site.latitude,
        pickupLng: site.longitude,
        bestBefore: new Date(dto.bestBefore),
        pickupFromTime: dto.pickupFromTime ? new Date(dto.pickupFromTime) : null,
        pickupByTime: dto.pickupByTime ? new Date(dto.pickupByTime) : null,
        needsRefrigeration: dto.needsRefrigeration ?? false,
        needsReheating: dto.needsReheating ?? false,
        containsAllergens: dto.containsAllergens ?? false,
        status: this.deriveStatus(remainingQtyKg, totalQtyKg) as any,
      },
    });

    this.logger.log(
      `Listing created: id=${listing.id} org=${organisationId} site=${dto.siteId} qty=${totalQtyKg}kg`,
    );

    return listing;
  }

  async relistListing(organisationId: number, listingId: number, dto: RelistDto) {
    const original = await this.prisma.foodListing.findFirst({
      where: { id: listingId, organisationId },
    });

    if (!original) throw new NotFoundException('Listing not found');

    const foodItems = dto.foodItems ?? (original.foodItems as unknown as FoodItemDto[]);
    const totalQtyKg = this.sumTotal(foodItems);
    const remainingQtyKg = this.sumRemaining(foodItems);

    const newListing = await this.prisma.foodListing.create({
      data: {
        siteId: original.siteId,
        organisationId,
        foodItems: foodItems as any,
        totalQtyKg,
        remainingQtyKg,
        pickupAddress: original.pickupAddress,
        pickupPostcode: original.pickupPostcode,
        pickupLat: dto.pickupLat ?? original.pickupLat,
        pickupLng: dto.pickupLng ?? original.pickupLng,
        bestBefore: new Date(dto.bestBefore),
        pickupFromTime: dto.pickupFromTime ? new Date(dto.pickupFromTime) : null,
        pickupByTime: dto.pickupByTime ? new Date(dto.pickupByTime) : null,
        needsRefrigeration: original.needsRefrigeration,
        needsReheating: original.needsReheating,
        containsAllergens: original.containsAllergens,
        isGlutenFree: original.isGlutenFree,
        isSafeForDonation: original.isSafeForDonation,
        relistOfId: original.id,
        status: this.deriveStatus(remainingQtyKg, totalQtyKg) as any,
      },
    });

    this.logger.log(
      `Listing relisted: new=${newListing.id} original=${listingId} org=${organisationId}`,
    );

    return newListing;
  }

  async getListings(organisationId: number, query: GetListingsQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const skip = (page - 1) * limit;

    const where: any = { organisationId };
    if (query.status) where.status = query.status;

    const [listings, total] = await this.prisma.$transaction([
      this.prisma.foodListing.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: { _count: { select: { foodClaims: true } } },
      }),
      this.prisma.foodListing.count({ where }),
    ]);

    return { listings, total, page, limit };
  }

  async getListing(organisationId: number, listingId: number) {
    const listing = await this.prisma.foodListing.findFirst({
      where: { id: listingId, organisationId },
      include: {
        foodClaims: true,
        listingActivities: { orderBy: { createdAt: 'desc' } },
      },
    });

    if (!listing) throw new NotFoundException('Listing not found');
    return listing;
  }

  async cancelListing(organisationId: number, listingId: number) {
    const listing = await this.prisma.foodListing.findFirst({
      where: { id: listingId, organisationId },
    });

    if (!listing) throw new NotFoundException('Listing not found');

    if (listing.status === 'CANCELLED') {
      throw new BadRequestException('Listing is already cancelled');
    }
    if (listing.status === 'CLAIMED') {
      throw new BadRequestException('Cannot cancel a fully claimed listing');
    }

    return this.prisma.foodListing.update({
      where: { id: listingId },
      data: { status: 'CANCELLED' as any },
    });
  }

  async updateListing(organisationId: number, listingId: number, dto: UpdateListingDto) {
    const listing = await this.prisma.foodListing.findFirst({
      where: { id: listingId, organisationId },
    });

    if (!listing) throw new NotFoundException('Listing not found');

    if (!['ACTIVE', 'PARTIAL'].includes(listing.status)) {
      throw new BadRequestException('Only active or partial listings can be updated');
    }

    const data: any = {};

    if (dto.foodItems) {
      data.foodItems = dto.foodItems as any;
      data.totalQtyKg = this.sumTotal(dto.foodItems);
      data.remainingQtyKg = this.sumRemaining(dto.foodItems);
      data.status = this.deriveStatus(data.remainingQtyKg, data.totalQtyKg);
    }

    if (dto.bestBefore) data.bestBefore = new Date(dto.bestBefore);
    if (dto.pickupFromTime) data.pickupFromTime = new Date(dto.pickupFromTime);
    if (dto.pickupByTime) data.pickupByTime = new Date(dto.pickupByTime);
    if (dto.needsRefrigeration !== undefined) data.needsRefrigeration = dto.needsRefrigeration;
    if (dto.needsReheating !== undefined) data.needsReheating = dto.needsReheating;
    if (dto.containsAllergens !== undefined) data.containsAllergens = dto.containsAllergens;
    if (dto.isGlutenFree !== undefined) data.isGlutenFree = dto.isGlutenFree;
    if (dto.isSafeForDonation !== undefined) data.isSafeForDonation = dto.isSafeForDonation;

    return this.prisma.foodListing.update({ where: { id: listingId }, data });
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  private sumTotal(items: FoodItemDto[]): number {
    return items.reduce((sum, i) => sum + i.totalQtyKg, 0);
  }

  private sumRemaining(items: FoodItemDto[]): number {
    return items.reduce((sum, i) => sum + i.remainingQtyKg, 0);
  }

  private deriveStatus(remaining: number, total: number): string {
    if (remaining <= 0) return 'CLAIMED';
    if (remaining < total) return 'PARTIAL';
    return 'ACTIVE';
  }
}
