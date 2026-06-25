import { Module } from '@nestjs/common';
import { S3Module } from '../../uploads/s3/s3.module';
import { DriverLocationService } from './service/driver.location.service';
import { DriverController } from './controller/driver.controller';

@Module({
  imports: [S3Module],
  controllers: [DriverController],
  providers: [DriverLocationService],
  exports: [DriverLocationService],
})
export class DriversModule {}
