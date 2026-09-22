


import {Module} from "@nestjs/common"
import { HealthController } from "./health.controller";
import { HealthService } from "./HealthService";
import { PrismaService } from "src/infra/prisma/prisma.service";
import { TerminusModule } from "@nestjs/terminus";


@Module({
  imports: [TerminusModule],
  controllers: [HealthController],
  providers: [HealthService],
  exports: [],
})
export class HealthModule{}