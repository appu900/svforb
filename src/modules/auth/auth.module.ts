import { Module } from '@nestjs/common';
import { AuthService } from './service/auth.service';
import { AuthCacheManager } from './cache/auth.cache.manager';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { S3Module } from '../../uploads/s3/s3.module';
import { AuthController } from './auth.controller';
import { JwtStrategy } from '../../common/strategies/jwt.strategy';
import { ProximityModule } from '../psearch/psearch.module';
import { RedisGeoSearchModule } from '../redis-geo-search/redis-geo-search.module';

@Module({
  imports: [
    PassportModule.register({ defaultStrategy: 'jwt' }),
    ConfigModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('JWT_SECRET'),
        signOptions: { expiresIn: config.get<string>('JWT_EXPIRES_IN') || '7d' },
      }),
    }),
    S3Module,
    ProximityModule,
    RedisGeoSearchModule,
  ],
  controllers: [AuthController],
  providers: [AuthService, AuthCacheManager, JwtStrategy],
  exports: [AuthService, JwtModule],
})
export class AuthModule {}
