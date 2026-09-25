import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, OpenAPIObject, SwaggerModule } from '@nestjs/swagger';
import { ClaimsModule } from './modules/claims/claims.module';
import { DriversModule } from './modules/drivers/drivers.module';
import { FoodListingModule } from './modules/foodlisting/foodlisting.module';
import { ImpactModule } from './modules/impact/impact.module';
import { ProximityModule } from './modules/psearch/psearch.module';

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

/**
 * A second, narrower reference covering only the food redirection path:
 * restaurant surplus reaching a charity or a farmer.
 *
 * The full document at /api/docs carries every endpoint in the platform,
 * which is the wrong thing to hand someone integrating this one journey —
 * `include` scopes it to the modules that journey actually touches.
 */
export function buildFoodRedirectionDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('Food Redirection API')
    .setDescription(
      'Restaurant surplus reaching charities and farmers.\n\n' +
        '**Two classifications, doing different jobs.**\n\n' +
        '`listingType` is an *access rule* — it decides who may claim:\n' +
        '- `HUMAN` — fit for people. Charities only.\n' +
        '- `ANIMAL` — livestock feed. Farmer consumers only.\n' +
        '- `BOTH` — either. Charities and farmer consumers.\n\n' +
        '`recoveryPathway` is the *reporting dimension* — what actually happened: ' +
        '`FOOD_FOR_PEOPLE`, `LIVESTOCK_FEED`, `CIRCULAR_RECOVERY`, `BIOENERGY`. ' +
        'It sits on the claim as well as the listing, because a `BOTH` listing ' +
        'taken by a charity and the same listing taken by a farmer have different ' +
        'outcomes.\n\n' +
        '**Quantity is always kilograms.** `totalQtyKg` is immutable — it records ' +
        'what was offered. Only `remainingQtyKg` moves, on the listing and on each ' +
        'food item, and listing status is derived from it: `remaining > 0` is ' +
        '`PARTIAL`, `<= 0` is `CLAIMED`. That is what lets several charities share ' +
        'one listing.\n\n' +
        '**Authentication.** Bearer token from `POST /auth/login`, except where an ' +
        'endpoint is marked public.',
    )
    .setVersion('1.0')
    .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'bearer')
    .addTag('FoodListing', 'Creating and finding surplus listings')
    .addTag('Claims', 'Claiming, collecting, rating')
    .addTag('Driver', 'Driver-assisted collection')
    .addTag('Impact', 'Weight redirected, meals, CO2e')
    .addTag('Proximity', 'Public location search')
    .build();

  return SwaggerModule.createDocument(app, config, {
    include: [
      FoodListingModule,
      ClaimsModule,
      DriversModule,
      ImpactModule,
      ProximityModule,
    ],
  });
}

/** Serves the scoped reference at /api/docs/food. */
export function setupFoodRedirectionSwagger(app: INestApplication): OpenAPIObject {
  const document = buildFoodRedirectionDocument(app);

  SwaggerModule.setup('api/docs/food', app, document, {
    jsonDocumentUrl: 'api/docs/food/openapi.json',
    swaggerOptions: {
      persistAuthorization: true,
      tagsSorter: 'alpha',
      operationsSorter: 'alpha',
      docExpansion: 'none',
    },
    customSiteTitle: 'Food Redirection API',
  });

  return document;
}
