process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';
import { MailerService } from './modules/notifications/services/mailer.service';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('/api/v1');
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );
  // const mailservice = app.get(MailerService);
  // const res = await mailservice.sendOtp('pabitradakua85@gmail.com', '123456');
  // console.log(res)
  app.enableCors();
  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
