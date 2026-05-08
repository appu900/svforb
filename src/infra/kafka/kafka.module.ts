import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { group } from 'console';

@Module({
  imports: [
    ClientsModule.register([
      {
        name: 'KAFKA_SERVICE',
        transport: Transport.KAFKA,
        options: {
          client: {
            brokers: [process.env.KAFKA_BROKER || 'localhost:9092'],
          },
          consumer: {
            groupId: 'consumer-group',
          },
        },
      },
    ]),
  ],
  controllers: [],
  providers: [],
  exports: [ClientsModule],
})
export class KafkaModule {}
