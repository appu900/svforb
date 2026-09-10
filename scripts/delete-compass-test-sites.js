/**
 * Hard-delete Compass test sites and detach users from them.
 * Site admin accounts are kept.
 *
 *   node scripts/delete-compass-test-sites.js          # preview
 *   APPLY=1 node scripts/delete-compass-test-sites.js  # perform
 *
 * Sites whose name, code, email, or contact contains "test" are removed.
 * Set ALL_SITES=1 to include every Compass site.
 */
const fs = require("fs");
const { Pool } = require("pg");

function loadEnv(file) {
  const env = {};
  if (!fs.existsSync(file)) return env;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m) continue;
    let v = m[2];
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    env[m[1]] = v;
  }
  return env;
}

function sanitizeUrl(url) {
  return url
    .replace(/[?&]sslrootcert=[^&]*/g, "")
    .replace(/[?&]sslmode=[^&]*/g, "")
    .replace(/\?$/, "");
}

function isTestSite(site) {
  const blob = [
    site.name,
    site.organisationName,
    site.siteCode,
    site.contactName,
    site.contactEmail,
    site.address,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return /\btest\b|test site|testing|dummy|demo site/.test(blob);
}

async function main() {
  const env = { ...loadEnv(".env"), ...process.env };
  const apply = env.APPLY === "1";
  const allSites = env.ALL_SITES === "1";
  if (!env.DATABASE_URL) {
    console.error("DATABASE_URL is missing");
    process.exit(1);
  }

  const pool = new Pool({
    connectionString: sanitizeUrl(env.DATABASE_URL),
    ssl: { rejectUnauthorized: false },
  });

  try {
    const orgs = await pool.query(`
      SELECT id, name, "organizationType"
      FROM organisations
      WHERE name ILIKE '%compass%'
      ORDER BY id
    `);
    if (orgs.rows.length === 0) {
      console.log("No Compass organisation found.");
      return;
    }
    console.log("Organisations:");
    for (const org of orgs.rows) {
      console.log(`  #${org.id} ${org.name} (${org.organizationType})`);
    }

    const orgIds = orgs.rows.map((o) => o.id);
    const sites = await pool.query(
      `
      SELECT id, "organisationId", name, "organisationName", "siteCode",
             address, "contactName", "contactEmail", "isActive", "createdAt"
      FROM sites
      WHERE "organisationId" = ANY($1::int[])
      ORDER BY id
    `,
      [orgIds],
    );

    const targets = sites.rows.filter((s) => allSites || isTestSite(s));
    console.log(`\nAll Compass sites: ${sites.rows.length}`);
    for (const s of sites.rows) {
      const mark = targets.some((t) => t.id === s.id) ? "DELETE" : "keep";
      console.log(
        `  [${mark}] #${s.id} active=${s.isActive} code=${s.siteCode || "-"} name=${s.name || s.organisationName} email=${s.contactEmail}`,
      );
    }

    if (targets.length === 0) {
      console.log(
        "\nNo test sites matched. Re-run with ALL_SITES=1 to delete every Compass site.",
      );
      return;
    }

    const siteIds = targets.map((s) => s.id);
    const admins = await pool.query(
      `
      SELECT sa.id AS access_id, sa."siteId", sa."siteRole", sa."userId",
             u."firstName", u."lastName", u.email, u."isActive" AS user_active,
             om."orgRole"
      FROM site_accesses sa
      JOIN users u ON u.id = sa."userId"
      LEFT JOIN org_membership om
        ON om."userId" = u.id AND om."organisationId" = sa."organisationId"
      WHERE sa."siteId" = ANY($1::int[])
      ORDER BY sa."siteId"
    `,
      [siteIds],
    );

    console.log("\nUsers who will be detached (accounts kept):");
    for (const a of admins.rows) {
      console.log(
        `  site #${a.siteId} ${a.siteRole} user #${a.userId} ${a.firstName} ${a.lastName} <${a.email}>`,
      );
    }

    if (!apply) {
      console.log(
        `\nPreview only. ${targets.length} site(s) would be permanently deleted and ${admins.rows.length} access row(s) detached.`,
      );
      console.log("Re-run with APPLY=1 to perform.");
      return;
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `DELETE FROM driver_pickups
         WHERE "listingId" IN (SELECT id FROM food_listings WHERE "siteId" = ANY($1::int[]))
            OR "claimId" IN (
              SELECT id FROM food_claims
              WHERE "claimantSiteId" = ANY($1::int[])
                 OR "listingId" IN (SELECT id FROM food_listings WHERE "siteId" = ANY($1::int[]))
            )`,
        [siteIds],
      );
      await client.query(
        `DELETE FROM claim_items WHERE "claimId" IN (
           SELECT id FROM food_claims
           WHERE "claimantSiteId" = ANY($1::int[])
              OR "listingId" IN (SELECT id FROM food_listings WHERE "siteId" = ANY($1::int[]))
         )`,
        [siteIds],
      );
      await client.query(
        `DELETE FROM food_claims
         WHERE "claimantSiteId" = ANY($1::int[])
            OR "listingId" IN (SELECT id FROM food_listings WHERE "siteId" = ANY($1::int[]))`,
        [siteIds],
      );
      await client.query(
        `DELETE FROM listing_activity
         WHERE "listingId" IN (SELECT id FROM food_listings WHERE "siteId" = ANY($1::int[]))`,
        [siteIds],
      );
      await client.query(
        `DELETE FROM food_items
         WHERE "listingId" IN (SELECT id FROM food_listings WHERE "siteId" = ANY($1::int[]))`,
        [siteIds],
      );
      await client.query(
        `DELETE FROM site_notifications WHERE "siteId" = ANY($1::int[])`,
        [siteIds],
      );
      await client.query(
        `DELETE FROM food_listings WHERE "siteId" = ANY($1::int[])`,
        [siteIds],
      );
      await client.query(
        `DELETE FROM site_alert_states WHERE "siteId" = ANY($1::int[])`,
        [siteIds],
      );
      const analytics = await client.query(`
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'SiteAnalytics'
      `);
      if (analytics.rowCount) {
        await client.query(
          `DELETE FROM "SiteAnalytics" WHERE "siteId" = ANY($1::int[])`,
          [siteIds],
        );
      }
      await client.query(
        `DELETE FROM cluster_sites WHERE "siteId" = ANY($1::int[])`,
        [siteIds],
      );
      await client.query(
        `DELETE FROM territory_sites WHERE "siteId" = ANY($1::int[])`,
        [siteIds],
      );
      await client.query(
        `DELETE FROM group_sites WHERE "siteId" = ANY($1::int[])`,
        [siteIds],
      );
      await client.query(
        `DELETE FROM site_accesses WHERE "siteId" = ANY($1::int[])`,
        [siteIds],
      );
      await client.query(
        `DELETE FROM user_scopes WHERE "scopeType" = 'SITE' AND "scopeId" = ANY($1::int[])`,
        [siteIds],
      );
      await client.query(
        `UPDATE site_import_rows SET "siteId" = NULL WHERE "siteId" = ANY($1::int[])`,
        [siteIds],
      );
      await client.query(
        `
        UPDATE enterprise_invitations
        SET "siteAdminForSiteId" = NULL, status = 'REVOKED', "revokedAt" = NOW()
        WHERE "siteAdminForSiteId" = ANY($1::int[])
          AND status = 'PENDING'
      `,
        [siteIds],
      );
      await client.query(
        `UPDATE enterprise_invitations
         SET "siteAdminForSiteId" = NULL
         WHERE "siteAdminForSiteId" = ANY($1::int[])`,
        [siteIds],
      );
      await client.query(`DELETE FROM sites WHERE id = ANY($1::int[])`, [siteIds]);

      await client.query("COMMIT");
      console.log(
        `\nDone. Permanently deleted ${targets.length} site(s) and detached ${admins.rows.length} user access row(s). Admin accounts were not changed.`,
      );
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
