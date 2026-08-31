import "dotenv/config";
import postgres from "postgres";

const raw = process.env.DATABASE_URL;
if (!raw) {
  console.error("NO_DATABASE_URL");
  process.exit(1);
}

const url = new URL(raw);
console.log("params:", [...url.searchParams.keys()].join(","));
console.log("sslmode:", url.searchParams.get("sslmode"));
console.log("sslrootcert:", url.searchParams.get("sslrootcert"));

async function tryConnect(label, connectionString) {
  const sql = postgres(connectionString, { max: 1, connect_timeout: 15 });
  try {
    const rows = await sql`select current_database() as db, current_user as usr`;
    console.log(label, "CONNECT_OK", rows[0].db, rows[0].usr);
    const meta = await sql`
      select "ns"."nspname" as "schema", "cls"."relname" as "name"
      from "pg_catalog"."pg_class" as "cls"
      inner join "pg_catalog"."pg_namespace" as "ns" on "cls"."relnamespace" = "ns"."oid"
      where "ns"."nspname" = 'public'
      and "cls"."relkind" in ('r', 'p')
      limit 3
    `;
    console.log(label, "META_OK", meta.length, meta.map((r) => r.name).join(","));
  } catch (e) {
    console.log(label, "FAIL", e.name, e.code || "", String(e.message).slice(0, 400));
  } finally {
    await sql.end({ timeout: 2 });
  }
}

await tryConnect("AS_IS", raw);

const stripped = new URL(raw);
stripped.searchParams.delete("sslrootcert");
stripped.searchParams.set("sslmode", "require");
await tryConnect("STRIPPED", stripped.toString());
