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
import { ProximityModule } from './modules/psearch/psearch.module';
import { OrganizationModule } from './modules/organisation/organization.module';
import { RedisProxyModule } from './modules/redisProxy/redis.proxy.module';
import { RedisGeoSearchModule } from './modules/redis-geo-search/redis-geo-search.module';
import { FoodListingModule } from './modules/foodlisting/foodlisting.module';
import { GatewayModule } from './gateway/gateway.module';
import { DriversModule } from './modules/drivers/drivers.module';
import { ClaimsModule } from './modules/claims/claims.module';
import { ImpactModule } from './modules/impact/impact.module';
import { FarmerConsumerModule } from './modules/farmer-consumer/farmer-consumer.module';
import { BillingModule } from './modules/billing/billing.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    GatewayModule,
    DriversModule,
    ClaimsModule,
    PrismaModule,
    RedisModule,
    NotificationModule,
    AuthModule,
    SubscriptionsModule,
    SitesModule,
    CharityModule,
    ProximityModule,
    OrganizationModule,
    RedisProxyModule,
    RedisGeoSearchModule,
    FoodListingModule,
    ImpactModule,
    FarmerConsumerModule,
    BillingModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}



