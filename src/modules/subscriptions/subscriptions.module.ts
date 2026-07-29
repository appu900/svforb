import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { SubscriptionsService } from './subscriptions.service';
import { SubscriptionsController } from './subscriptions.controller';
import { SubscriptionAccessService } from './services/subscription-access.service';
import { SubscriptionInterceptor } from './interceptors/subscription.interceptor';
import { AuthModule } from '../auth/auth.module';

@Global()
@Module({
  imports: [AuthModule],
  controllers: [SubscriptionsController],
  providers: [
    SubscriptionsService,
    SubscriptionAccessService,
    { provide: APP_INTERCEPTOR, useClass: SubscriptionInterceptor },
  ],
  exports: [SubscriptionAccessService],
})
export class SubscriptionsModule {}
