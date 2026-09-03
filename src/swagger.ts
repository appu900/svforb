import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, OpenAPIObject, SwaggerModule } from '@nestjs/swagger';

/**
 * Builds the OpenAPI document.
 *
 * Schemas come from the existing class-validator DTOs via the @nestjs/swagger
 * CLI plugin (enabled in nest-cli.json), so the reference tracks the code
 * rather than being maintained beside it.
 */
export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('Saveful for Business API')
    .setDescription(
      'Food rescue platform API. All routes are prefixed `/api/v1`.\n\n' +
        '**Authentication.** Every endpoint requires a bearer token unless marked ' +
        'otherwise. Obtain one from `POST /auth/login`, then send it as ' +
        '`Authorization: Bearer <token>`.\n\n' +
        '**Enterprise endpoints** additionally require the organisation to be on the ' +
        'Enterprise plan, and are gated on the caller’s Enterprise role and scope. ' +
        'A 403 carrying `MISSING_PERMISSION` means the role is wrong; one carrying ' +
        '`OUTSIDE_SCOPE` means the role is right but the target sits outside what the ' +
        'caller can reach.',
    )
    .setVersion('1.0')
    .addBearerAuth(
      { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      'bearer',
    )
    .addTag('Auth', 'Registration, login, password reset, email verification')
    .addTag('Enterprise · Structure', 'Groups, Clusters and Territories — three independent dimensions')
    .addTag('Enterprise · Users', 'Members, invitations, roles and scopes')
    .addTag('Enterprise · Roles', 'The permission matrix the guards read')
    .addTag('Enterprise · Provisioning', 'Saveful-side Enterprise creation and profile')
    .addTag('Enterprise · Reports', 'Impact and breakdown reporting across any dimension')
    .addTag('Enterprise · Billing', 'Contracts and invoices')
    .addTag('Sites', 'Site records and staff access')
    .addTag('Food Listings', 'Surplus food offered for collection')
    .addTag('Claims', 'Claiming, collection, ratings and provider feedback')
    .addTag('Drivers', 'Driver assignment and pickups')
    .addTag('Billing & Subscriptions', 'Stripe plans, trials, checkout')
    .addTag('Charity', 'Charity locations and users')
    .addTag('Notifications', 'Device tokens and dispatch')
    .build();

  return SwaggerModule.createDocument(app, config);
}

/** Serves the interactive reference at /api/docs. */
export function setupSwagger(app: INestApplication): OpenAPIObject {
  const document = buildOpenApiDocument(app);

  SwaggerModule.setup('api/docs', app, document, {
    jsonDocumentUrl: 'api/docs/openapi.json',
    swaggerOptions: {
      persistAuthorization: true,
      tagsSorter: 'alpha',
      operationsSorter: 'alpha',
      docExpansion: 'none',
    },
    customSiteTitle: 'Saveful for Business API',
  });

  return document;
}
