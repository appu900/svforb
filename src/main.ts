process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { Logger, ValidationPipe } from '@nestjs/common';
import * as basicAuth from 'express-basic-auth';
import * as compression from 'compression';
import { setupFoodRedirectionSwagger, setupSwagger } from './swagger';


async function bootstrap() {
  // rawBody is required by the Stripe webhook — signature verification runs
  // against the exact bytes Stripe sent, not the re-serialised JSON.
  const app = await NestFactory.create(AppModule, { rawBody: true });

  // gzip every response. The Swagger UI bundle alone is 1.5 MB uncompressed
  // and the docs page ships 2.27 MB in total, which is most of why it was slow
  // to open over a real network. Applies to API responses as well — large
  // listing and report payloads compress just as well.
  //
  // Response-only, so the Stripe webhook's raw request body is untouched.
  app.use(compression());

  // The queue dashboard exposes raw job payloads — including OTP codes — so it
  // is gated before anything else can route to it.
  //
  // Both paths are guarded on purpose: bull-board registers its route through
  // Nest, so setGlobalPrefix DOES apply and it serves from
  // /api/v1/admin/queues. The unprefixed path is covered too, so moving or
  // removing the prefix later cannot silently expose it.
  //
  // With no password configured the route is refused outright rather than left
  // open: an unset env var must never become a public dashboard.
  const QUEUE_DASHBOARD_PATHS = ['/admin/queues', '/api/v1/admin/queues'];
  const queuePassword = process.env.QUEUE_DASHBOARD_PASSWORD;
  if (queuePassword) {
    app.use(
      QUEUE_DASHBOARD_PATHS,
      basicAuth({
        challenge: true,
        realm: 'Saveful queues',
        users: { [process.env.QUEUE_DASHBOARD_USER ?? 'admin']: queuePassword },
      }),
    );
  } else {
    app.use(QUEUE_DASHBOARD_PATHS, (_req: unknown, res: any) => {
      res.status(503).json({
        message: 'Queue dashboard is disabled. Set QUEUE_DASHBOARD_PASSWORD to enable it.',
      });
    });
    new Logger('Bootstrap').warn(
      'QUEUE_DASHBOARD_PASSWORD is not set — /admin/queues is disabled.',
    );
  }

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

  // A narrower reference for the food redirection journey alone, so someone
  // integrating that path is not handed all 243 platform endpoints.
  setupFoodRedirectionSwagger(app);

  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
