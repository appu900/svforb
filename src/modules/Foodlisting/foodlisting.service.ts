import { Logger, Injectable } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { CreateListingDto } from './dto/food.listing.dto';

interface FoodItem {
  category: string;
  totalQtyKg: number;
  remainingQtkKg: number;
}

@Injectable()
export class FoodListingService {
  private readonly logger = new Logger(FoodListingService.name);
  constructor(private readonly prisma: PrismaService) {}

  private sumTotal(items: FoodItem[]): number {
    return items.reduce((s, i) => s + i.totalQtyKg, 0);
  }

  private sunRemaining(items: FoodItem[]): number {
    return items.reduce((s, i) => s + i.remainingQtkKg, 0);
  }

  private deriveStatus(remaining: number, total: number) {
    if (remaining <= 0) return 'CLAIMED';
    if (remaining < total) return 'PARTIAL';
    return 'ACTIVE';
  }

  async createListing(organisationId: number, dto: CreateListingDto) {
    const site = await this.prisma.site.findUnique({
      where: { id: dto.siteId },
    });
  }
}
