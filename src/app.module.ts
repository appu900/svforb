import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './infra/prisma/prisma.module';
import { ConfigModule } from '@nestjs/config';
import { RedisModule } from './infra/redis/redis.module';
import { NotificationModule } from './modules/notifications/notification.module';
import { AuthModule } from './modules/auth/auth.module';
import { SubscriptionsModule } from './modules/subscriptions/subscriptions.module';
import { SitesModule } from './modules/sites/sites.module';
import { CharityModule } from './modules/charity/charity.module';
import { FoodListingModule } from './modules/Foodlisting/foodlisting.module';
import { ProximityModule } from './modules/psearch/psearch.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    RedisModule,
    NotificationModule,
    AuthModule,
    SubscriptionsModule,
    SitesModule,
    CharityModule,
    FoodListingModule,
    ProximityModule
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
