import { Logger } from '@nestjs/common';
import {
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketGateway,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { DriverLocationService } from '../modules/drivers/service/driver.location.service';

export interface ListingEvents {
  listingId: number;
  eventType: string;
  message: string;
  claimId?: number;
  driverInfo?: {
    id: number;
    name: string;
    vehicleType?: string | null;
    phoneNumber: string;
  };
  timestamp: string;
}

@WebSocketGateway({ cors: { origin: '*' }, namespace: '/listings' })
export class ListingGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() server!: Server;
  private logger = new Logger(ListingGateway.name);

  constructor(private readonly driverService: DriverLocationService) {}

  async handleConnection(client: Socket) {
    this.logger.log(`Client connected: ${client.id}`);
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Client disconnected: ${client.id}`);
  }

  // Restaurant subscribes to listing-level events (all claims, status changes)
  @SubscribeMessage('subscribe:listing')
  handleListingSubscribe(
    @MessageBody() data: { listingId: number },
    @ConnectedSocket() client: Socket,
  ) {
    const room = `listing:${data.listingId}`;
    client.join(room);
    this.logger.log(`socket=${client.id} joined listing room=${room}`);
    return { status: 'subscribed', room };
  }

  // Charity + Restaurant subscribe to a specific claim (driver location, driver assigned)
  @SubscribeMessage('subscribe:claim')
  handleClaimSubscribe(
    @MessageBody() data: { claimId: number },
    @ConnectedSocket() client: Socket,
  ) {
    const room = `claim:${data.claimId}`;
    client.join(room);
    this.logger.log(`socket=${client.id} joined claim room=${room}`);
    return { status: 'subscribed', room };
  }

  // Driver taps "Accept" — creates DB record, joins claim room, broadcasts to both rooms
  @SubscribeMessage('driver:accept')
  async handleDriverAccept(
    @MessageBody() data: { driverId: number; listingId: number; claimId: number },
    @ConnectedSocket() client: Socket,
  ) {
    let result: Awaited<ReturnType<DriverLocationService['acceptPickup']>>;

    try {
      result = await this.driverService.acceptPickup(data.driverId, data.claimId, data.listingId);
    } catch (err: any) {
      return { status: 'error', message: err.message };
    }

    const driver = await this.driverService.getDriverInfo(data.driverId);
    if (!driver) return { status: 'error', message: 'Driver is not live' };

    client.join(`claim:${data.claimId}`);

    const driverInfo = {
      id: driver.userId,
      name: driver.name,
      vehicleType: driver.vehicleType,
      phoneNumber: driver.phone,
    };

    this.server.to(`claim:${data.claimId}`).emit('listing.event', {
      listingId: data.listingId,
      eventType: 'DRIVER_ASSIGNED',
      message: `${driver.name} is on the way to collect`,
      claimId: data.claimId,
      driverInfo,
      timestamp: new Date().toISOString(),
    });

    this.server.to(`listing:${data.listingId}`).emit('listing.event', {
      listingId: data.listingId,
      eventType: 'DRIVER_ASSIGNED',
      message: `${driver.name} is heading to collect claim #${data.claimId}`,
      claimId: data.claimId,
      driverInfo,
      timestamp: new Date().toISOString(),
    });

    this.logger.log(
      `Driver ${data.driverId} (${driver.name}) accepted claim=${data.claimId} listing=${data.listingId}`,
    );

    // Return restaurant coords so driver app can show map immediately
    return {
      status: 'accepted',
      pickupId: result.pickup.id,
      claimRoom: `claim:${data.claimId}`,
      restaurant: result.restaurant,
    };
  }

  // Driver streams location → only to claim room (so each charity sees only their driver)
  @SubscribeMessage('driver:location')
  async handleDriverLocation(
    @MessageBody() data: { driverId: number; claimId: number; lat: number; lng: number },
  ) {
    const updated = await this.driverService.updateLocation(data.driverId, data.lat, data.lng);
    if (!updated) {
      return { status: 'error', message: 'Driver session expired — go live again' };
    }

    this.server.to(`claim:${data.claimId}`).emit('driver.location', {
      driverId: data.driverId,
      driverName: updated.name,
      claimId: data.claimId,
      lat: data.lat,
      lng: data.lng,
      timestamp: new Date().toISOString(),
    });

    return { status: 'ok' };
  }

  pushListingEvents(listingId: number, event: ListingEvents) {
    this.server.to(`listing:${listingId}`).emit('listing.event', event);
  }
}
