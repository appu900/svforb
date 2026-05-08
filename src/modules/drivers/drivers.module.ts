import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { RedisModule } from 'src/infra/redis/redis.module';
@Module({
  imports: [
    BullModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (config: ConfigService) => {
        const url = config.get<string>('REDIS_URL');
        const tls = config.get<string>('REDIS_TLS') === 'true';
        return {
          connection: url
            ? { url, ...(tls ? { tls: {} } : {}) }
            : {
                host: config.get<string>('REDIS_HOST', 'localhost'),
                port: config.get<number>('REDIS_PORT', 6379),
                password: config.get<string>('REDIS_PASSWORD'),
                username: config.get<string>('REDIS_USERNAME'),
                ...(tls ? { tls: {} } : {}),
              },
        };
      },
    }),
  ],
  controllers: [],
  providers: [],
  exports: [],
})
export class DriversModule {}
