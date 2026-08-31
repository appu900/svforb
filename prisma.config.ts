import "dotenv/config";
import { defineConfig } from "prisma/config";

/** libpq `sslrootcert=system` is not a file; node-pg / Prisma try to open it and crash. */
function datasourceUrl() {
  const url = process.env["DATABASE_URL"];
  if (!url) return url;
  const parsed = new URL(url);
  parsed.searchParams.delete("sslrootcert");
  return parsed.toString();
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "ts-node --compiler-options {\"module\":\"CommonJS\"} prisma/seed.ts",
  },
  datasource: {
    url: datasourceUrl(),
  },
});
