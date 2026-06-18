import { Logger, Module } from '@nestjs/common';
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
import { KafkaModule } from './infra/kafka/kafka.module';
import { OrganizationModule } from './modules/organisation/organization.module';
import { RedisProxyModule } from './modules/redisProxy/redis.proxy.module';
import { RedisGeoSearchModule } from './modules/redis-geo-search/redis-geo-search.module';
import { FoodListingModule } from './modules/foodlisting/foodlisting.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    KafkaModule,
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
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
