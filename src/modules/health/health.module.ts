


import {Module} from "@nestjs/common"
import { HealthController } from "./health.controller";
import { HealthService } from "./HealthService";
import { PrismaService } from "src/infra/prisma/prisma.service";
import { TerminusModule } from "@nestjs/terminus";
import { NotificationModule } from "../notifications/notification.module";


@Module({
  imports: [TerminusModule, NotificationModule],
  controllers: [HealthController],
  providers: [HealthService],
  exports: [],
})
export class HealthModule{}