import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { HttpCacheInterceptor } from './http-cache.interceptor';
import { HttpCacheService } from './http-cache.service';

/**
 * Global so workers, webhooks and gateways can invalidate the response cache
 * when they change data outside an HTTP write.
 */
@Global()
@Module({
  providers: [
    HttpCacheService,
    { provide: APP_INTERCEPTOR, useClass: HttpCacheInterceptor },
  ],
  exports: [HttpCacheService],
})
export class HttpCacheModule {}
