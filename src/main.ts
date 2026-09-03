process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';
import { setupSwagger } from './swagger';


async function bootstrap() {
  // rawBody is required by the Stripe webhook — signature verification runs
  // against the exact bytes Stripe sent, not the re-serialised JSON.
  const app = await NestFactory.create(AppModule, { rawBody: true });
  app.setGlobalPrefix('/api/v1');
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );
  app.enableCors();

  // Interactive reference at /api/docs, machine-readable at
  // /api/docs/openapi.json. Registered after the global prefix so the
  // documented paths match the ones the app actually serves.
  setupSwagger(app);

  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
