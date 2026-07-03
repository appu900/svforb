import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { Jwtpayload } from '../../../modules/auth/interface/jwt.interface';
import { DriverLocationService } from '../service/driver.location.service';
import {
  AcceptPickupDto,
  AssignDriverDto,
  CompletePickupDto,
  GoLiveDto,
  GoOfflineDto,
  RespondToPickupDto,
  UpdatePickupStatusDto,
} from '../dto/driver.dto';

@Controller('drivers')
@UseGuards(JwtAuthGuard)
export class DriverController {
  constructor(private readonly driverService: DriverLocationService) {}

  // ─── Live / Offline ───────────────────────────────────────────────────────

  @Post('live')
  async goLive(@Req() req: Request & { user: Jwtpayload }, @Body() dto: GoLiveDto) {
    const info = await this.driverService.goLive(
      req.user.sub,
      dto.siteId,
      dto.lat,
      dto.lng,
      dto.vehicleType,
    );
    if (!info) return { message: 'You do not have driver access to this site' };
    return { message: 'You are now live', driver: info };
  }

  @Delete('live')
  async goOffline(@Req() req: Request & { user: Jwtpayload }, @Body() dto: GoOfflineDto) {
    await this.driverService.goOffline(req.user.sub, dto.siteId);
    return { message: 'You are now offline' };
  }

  /** List drivers currently live on a site (for charity/farmer assignment UI). */
  @Get('site/:siteId/live')
  async getLiveDriversForSite(@Param('siteId', ParseIntPipe) siteId: number) {
    const drivers = await this.driverService.getLiveDriversForSite(siteId);
    return {
      drivers: drivers.map((d) => ({
        id: d.userId,
        name: d.name,
        phone: d.phone,
        online: true,
        vehicleType: d.vehicleType,
        lat: d.lat,
        lng: d.lng,
      })),
    };
  }

  // ─── Accept Pickup (driver self-selects) ──────────────────────────────────

  @Post('pickup/accept')
  async acceptPickup(
    @Req() req: Request & { user: Jwtpayload },
    @Body() dto: AcceptPickupDto,
  ) {
    return this.driverService.acceptPickup(req.user.sub, dto.claimId, dto.listingId);
  }

  // ─── Assign Driver (charity-initiated) ────────────────────────────────────

  @Post('pickups/assign')
  async assignDriver(
    @Req() req: Request & { user: Jwtpayload },
    @Body() dto: AssignDriverDto,
  ) {
    return this.driverService.assignDriverToPickup(
      req.user.orgId!,
      dto.claimId,
      dto.listingId,
      dto.driverId,
    );
  }

  @Patch('pickups/:id/respond')
  async respondToAssignment(
    @Req() req: Request & { user: Jwtpayload },
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: RespondToPickupDto,
  ) {
    return this.driverService.respondToPickupAssignment(id, req.user.sub, dto.accept);
  }


  @Get('pickups')
  async getMyPickups(
    @Req() req: Request & { user: Jwtpayload },
    @Query('filter') filter: 'current' | 'past' = 'current',
  ) {
    return this.driverService.getMyPickups(req.user.sub, filter);
  }

  @Get('pickups/:id')
  async getPickupDetails(
    @Req() req: Request & { user: Jwtpayload },
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.driverService.getPickupDetails(id, req.user.sub);
  }

  // ─── Status Update ────────────────────────────────────────────────────────

  @Patch('pickups/:id/status')
  async updateStatus(
    @Req() req: Request & { user: Jwtpayload },
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdatePickupStatusDto,
  ) {
    return this.driverService.updatePickupStatus(id, req.user.sub, dto.status);
  }

  // ─── Complete Pickup ──────────────────────────────────────────────────────

  @Post('pickups/:id/complete')
  @UseInterceptors(FileInterceptor('photo'))
  async completePickup(
    @Req() req: Request & { user: Jwtpayload },
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CompletePickupDto,
    @UploadedFile() photo?: Express.Multer.File,
  ) {
    return this.driverService.completePickup(id, req.user.sub, dto.notes, dto.rating, photo);
  }
}
