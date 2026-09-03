process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
import { NestFactory } from '@nestjs/core';
import * as fs from 'fs';
import * as path from 'path';
import { AppModule } from '../src/app.module';
import { buildOpenApiDocument } from '../src/swagger';

/**
 * Writes openapi.json without serving anything.
 *
 * The app is created but never listened on, which is enough for Nest to have
 * registered every route by the time the document is built.
 */
async function main() {
  const app = await NestFactory.create(AppModule, { logger: false });
  app.setGlobalPrefix('/api/v1');
  await app.init();

  const document = buildOpenApiDocument(app);
  const out = path.join(process.cwd(), 'docs', 'openapi.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(document, null, 2));

  const paths = Object.keys(document.paths ?? {});
  const operations = paths.reduce(
    (n, p) => n + Object.keys((document.paths as any)[p]).length,
    0,
  );
  console.log(`wrote ${out}`);
  console.log(`${paths.length} paths, ${operations} operations, ${Object.keys(document.components?.schemas ?? {}).length} schemas`);

  await app.close();
  process.exit(0);
}

main().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
