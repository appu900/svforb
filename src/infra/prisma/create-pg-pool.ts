import * as fs from 'fs';
import * as path from 'path';
import { Pool, PoolConfig } from 'pg';

/**
 * libpq treats `sslrootcert=system` as "use the OS CA store".
 * node-pg / pg-connection-string treat it as a file path and throw
 * `ENOENT: no such file or directory, open 'system'`.
 *
 * Strip those query params so TLS is configured only via `Pool.ssl`.
 */
const LIBPQ_SSL_PARAMS = ['sslrootcert', 'sslcert', 'sslkey', 'sslmode'] as const;

export function sanitizeDatabaseUrl(url = process.env.DATABASE_URL): string {
  if (!url) {
    throw new Error('DATABASE_URL is not set');
  }
  const parsed = new URL(url);
  for (const key of LIBPQ_SSL_PARAMS) {
    parsed.searchParams.delete(key);
  }
  return parsed.toString();
}

export function createPgPool(overrides: PoolConfig = {}): Pool {
  const caPath = path.join(process.cwd(), 'src/infra/prisma', 'ca.pem');
  return new Pool({
    connectionString: sanitizeDatabaseUrl(),
    ssl: fs.existsSync(caPath)
      ? { rejectUnauthorized: false, ca: fs.readFileSync(caPath).toString() }
      : { rejectUnauthorized: true },
    ...overrides,
  });
}
