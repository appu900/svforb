import { Module } from '@nestjs/common';
import { ImpactController } from './controller/impact.controller';
import { ImpactService } from './services/impact.service';

@Module({
  controllers: [ImpactController],
  providers: [ImpactService],
})
export class ImpactModule {}
