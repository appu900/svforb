import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { PushQueueService } from '../notifications/queues/push.queue.service';
import { CreateListingDto, FoodItemDto } from './dto/food.listing.dto';
import { ProximityService } from '../psearch/psearch.service';


@Injectable()
export class FoodListingService {
  private readonly logger = new Logger(FoodListingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly proximity: ProximityService,
    private readonly pushQueue: PushQueueService,
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
    const organisation = await this.prisma.organisation.findUnique({where:{id:site.organisationId}})
    if(!organisation) throw new BadRequestException("something went wrong")
    const region = organisation?.region
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

  // ─── Private helpers ───────────────────────────────────────────────────────

  // private async dispatchProximityNotification(
  //   listing: { id: number; pickupAddress: string; totalQtyKg: number; bestBefore: Date },
  //   site: { latitude: number; longitude: number; organisationName: string },
  // ): Promise<void> {
  //   const deviceTokens = await this.proximity.findNearbyCharityTokens(
  //     site.latitude,
  //     site.longitude,
  //   );

  //   if (!deviceTokens.length) {
  //     this.logger.log(`No nearby charity devices for listing ${listing.id}`);
  //     return;
  //   }

  //   await this.pushQueue.notifyNearbyCharities({
  //     listingId: listing.id,
  //     businessName: site.organisationName,
  //     pickupAddress: listing.pickupAddress,
  //     totalQtyKg: listing.totalQtyKg,
  //     bestBefore: listing.bestBefore.toISOString(),
  //     deviceTokens,
  //   });

  //   this.logger.log(
  //     `Proximity push queued: listing=${listing.id} tokens=${deviceTokens.length}`,
  //   );
  // }

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
