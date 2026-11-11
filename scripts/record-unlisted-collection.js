/**
 * Record a collection that happened without a listing: creates the listing,
 * a FULL claim by the collecting charity and marks it COLLECTED, writing the
 * same rows the app would (food items, claim items, activity, snapshots).
 *
 *   node scripts/record-unlisted-collection.js          # preview
 *   APPLY=1 node scripts/record-unlisted-collection.js  # perform
 *
 * Optional overrides:
 *   SITE_ID=123              provider site, when the site code is ambiguous
 *   CLAIMANT_ORG_ID=45       collecting charity, when the name is ambiguous
 *   CLAIMANT_SITE_ID=67      charity site that collected
 *   COLLECTED_AT=2026-11-11T15:00:00+11:00   defaults to now
 *   FORCE=1                  skip the duplicate check
 */
const fs = require("fs");
const { Pool } = require("pg");

const RECORD = {
  siteCode: "000111",
  siteNameHint: "olympic park",
  claimantName: "asylum seeker resource",
  items: [
    { name: "Fresh fruit & veg", kg: 80 },
    { name: "Snacks", kg: 81.5 },
    { name: "Drinks", kg: 14.25 },
  ],
  note: "Recorded by Saveful on behalf of the site: collected without a listing.",
};

const CHARITY_TYPES = ["CHARITY", "CHARITY_SINGLE", "CHARITY_MULTI"];

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

/** Columns are `timestamp without time zone` holding UTC, so always send UTC ISO strings. */
function utc(date) {
  return date.toISOString();
}

function local(date, timeZone) {
  return date.toLocaleString("en-AU", {
    timeZone,
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function round(value) {
  return Math.round(value * 100) / 100;
}

async function findSite(pool, env) {
  if (env.SITE_ID) {
    const { rows } = await pool.query(
      `SELECT * FROM sites WHERE id = $1`,
      [Number(env.SITE_ID)],
    );
    return rows;
  }
  const { rows } = await pool.query(
    `SELECT * FROM sites
     WHERE "siteCode" = $1 OR ltrim("siteCode", '0') = ltrim($1, '0')
     ORDER BY id`,
    [RECORD.siteCode],
  );
  if (rows.length === 0) {
    const { rows: named } = await pool.query(
      `SELECT * FROM sites
       WHERE name ILIKE $1 OR "organisationName" ILIKE $1 OR address ILIKE $1
       ORDER BY id`,
      [`%${RECORD.siteNameHint}%`],
    );
    if (named.length) {
      console.log(`No site has code ${RECORD.siteCode}. Sites matching "${RECORD.siteNameHint}":`);
      for (const s of named) {
        console.log(`  #${s.id} code=${s.siteCode || "-"} active=${s.isActive} ${s.name || s.organisationName} — ${s.address}`);
      }
      console.log("");
    }
    return [];
  }
  if (rows.length <= 1) return rows;
  const hinted = rows.filter((s) =>
    `${s.name || ""} ${s.organisationName || ""}`.toLowerCase().includes(RECORD.siteNameHint),
  );
  return hinted.length ? hinted : rows;
}

async function findClaimant(pool, env) {
  if (env.CLAIMANT_ORG_ID) {
    const { rows } = await pool.query(
      `SELECT id, name, "organizationType" FROM organisations WHERE id = $1`,
      [Number(env.CLAIMANT_ORG_ID)],
    );
    return rows;
  }
  const { rows } = await pool.query(
    `SELECT id, name, "organizationType" FROM organisations
     WHERE name ILIKE $1 ORDER BY id`,
    [`%${RECORD.claimantName}%`],
  );
  return rows;
}

async function snapshotFor(pool, siteId) {
  if (!siteId) {
    return { groupId: null, clusterId: null, territoryId: null };
  }
  const [group, cluster, territory] = await Promise.all([
    pool.query(`SELECT "groupId" FROM group_sites WHERE "siteId" = $1`, [siteId]),
    pool.query(`SELECT "clusterId" FROM cluster_sites WHERE "siteId" = $1`, [siteId]),
    pool.query(`SELECT "territoryId" FROM territory_sites WHERE "siteId" = $1`, [siteId]),
  ]);
  return {
    groupId: group.rows[0]?.groupId ?? null,
    clusterId: cluster.rows[0]?.clusterId ?? null,
    territoryId: territory.rows[0]?.territoryId ?? null,
  };
}

async function main() {
  const env = { ...loadEnv(".env"), ...process.env };
  const apply = env.APPLY === "1";
  if (!env.DATABASE_URL) {
    console.error("DATABASE_URL is missing");
    process.exit(1);
  }

  const collectedAt = env.COLLECTED_AT ? new Date(env.COLLECTED_AT) : new Date();
  if (Number.isNaN(collectedAt.getTime())) {
    console.error(`COLLECTED_AT is not a valid date: ${env.COLLECTED_AT}`);
    process.exit(1);
  }
  const pickupFrom = new Date(collectedAt.getTime() - 30 * 60 * 1000);
  const totalKg = round(RECORD.items.reduce((sum, item) => sum + item.kg, 0));

  const pool = new Pool({
    connectionString: sanitizeUrl(env.DATABASE_URL),
    ssl: { rejectUnauthorized: false },
  });

  try {
    const target = new URL(sanitizeUrl(env.DATABASE_URL));
    console.log(`Database: ${target.hostname}${target.pathname}\n`);

    const sites = await findSite(pool, env);
    if (sites.length !== 1) {
      console.log(`Expected exactly one provider site, found ${sites.length}:`);
      for (const s of sites) {
        console.log(`  #${s.id} code=${s.siteCode || "-"} active=${s.isActive} ${s.name || s.organisationName}`);
      }
      console.log("Re-run with SITE_ID=<id>.");
      process.exit(1);
    }
    const site = sites[0];
    if (!site.isActive) {
      console.error(`Site #${site.id} is deactivated.`);
      process.exit(1);
    }
    if (site.latitude == null || site.longitude == null) {
      console.error(`Site #${site.id} has no coordinates; a listing needs a pickup location.`);
      process.exit(1);
    }
    const timeZone = site.timezone || "Australia/Melbourne";

    const claimants = (await findClaimant(pool, env)).filter((org) =>
      CHARITY_TYPES.includes(org.organizationType),
    );
    if (claimants.length !== 1) {
      console.log(`Expected exactly one collecting charity, found ${claimants.length}:`);
      for (const org of claimants) {
        const { rows: [stats] } = await pool.query(
          `SELECT
             (SELECT count(*) FROM org_membership WHERE "organisationId" = $1)::int AS members,
             (SELECT count(*) FROM food_claims WHERE "claimantOrgId" = $1)::int AS claims,
             (SELECT count(*) FROM food_claims WHERE "claimantOrgId" = $1 AND status = 'COLLECTED')::int AS collected,
             (SELECT max("collectedAt") FROM food_claims WHERE "claimantOrgId" = $1) AS "lastCollectedAt",
             (SELECT "createdAt" FROM organisations WHERE id = $1) AS "createdAt",
             (SELECT count(*) FROM food_claims fc JOIN food_listings fl ON fl.id = fc."listingId"
               WHERE fc."claimantOrgId" = $1 AND fl."siteId" = $2)::int AS "fromThisSite",
             (SELECT count(*) FROM food_claims fc JOIN food_listings fl ON fl.id = fc."listingId"
               WHERE fc."claimantOrgId" = $1 AND fl."organisationId" = $3)::int AS "fromThisProvider"`,
          [org.id, site.id, site.organisationId],
        );
        const { rows: orgSites } = await pool.query(
          `SELECT id, name, "organisationName", "isActive" FROM sites WHERE "organisationId" = $1 ORDER BY id`,
          [org.id],
        );
        console.log(`  #${org.id} "${org.name}" (${org.organizationType})`);
        console.log(
          `    created ${stats.createdAt ? new Date(stats.createdAt).toISOString().slice(0, 10) : "-"} · ${stats.members} member(s) · ${stats.claims} claim(s), ${stats.collected} collected · last collection ${stats.lastCollectedAt ? new Date(stats.lastCollectedAt).toISOString().slice(0, 10) : "never"}`,
        );
        console.log(
          `    claims from this site: ${stats.fromThisSite} · from this provider's organisation: ${stats.fromThisProvider}`,
        );
        for (const s of orgSites) {
          console.log(`    site #${s.id} active=${s.isActive} ${s.name || s.organisationName}`);
        }
      }
      console.log("Re-run with CLAIMANT_ORG_ID=<id>.");
      process.exit(1);
    }
    const claimant = claimants[0];
    if (claimant.id === site.organisationId) {
      console.error("The charity and the provider are the same organisation.");
      process.exit(1);
    }

    const { rows: claimantSites } = await pool.query(
      `SELECT id, name, "organisationName", "isActive" FROM sites
       WHERE "organisationId" = $1 ORDER BY id`,
      [claimant.id],
    );
    let claimantSiteId = env.CLAIMANT_SITE_ID ? Number(env.CLAIMANT_SITE_ID) : null;
    if (claimantSiteId && !claimantSites.some((s) => s.id === claimantSiteId)) {
      console.error(`CLAIMANT_SITE_ID ${claimantSiteId} is not a site of ${claimant.name}.`);
      process.exit(1);
    }
    const activeClaimantSites = claimantSites.filter((s) => s.isActive);
    if (!claimantSiteId && activeClaimantSites.length === 1) {
      claimantSiteId = activeClaimantSites[0].id;
    }

    const { rows: duplicates } = await pool.query(
      `SELECT fl.id, fl."totalQtyKg", fl."createdAt"
       FROM food_listings fl
       JOIN food_claims fc ON fc."listingId" = fl.id AND fc."claimantOrgId" = $2
       WHERE fl."siteId" = $1
         AND abs(fl."totalQtyKg" - $3) < 0.01
         AND (fl."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE $4)::date
             = ($5::timestamp AT TIME ZONE 'UTC' AT TIME ZONE $4)::date`,
      [site.id, claimant.id, totalKg, timeZone, utc(collectedAt)],
    );

    const providerSnapshot = await snapshotFor(pool, site.id);
    const claimantSnapshot = await snapshotFor(pool, claimantSiteId);

    console.log("Provider site:");
    console.log(`  #${site.id} code=${site.siteCode || "-"} ${site.name || site.organisationName}`);
    console.log(`  ${site.address}${site.postcode ? ` ${site.postcode}` : ""} (org #${site.organisationId})`);
    console.log(`  snapshot group=${providerSnapshot.groupId ?? "-"} cluster=${providerSnapshot.clusterId ?? "-"} territory=${providerSnapshot.territoryId ?? "-"}`);
    console.log("Collected by:");
    console.log(`  #${claimant.id} ${claimant.name} (${claimant.organizationType})`);
    if (claimantSiteId) {
      const s = claimantSites.find((row) => row.id === claimantSiteId);
      console.log(`  site #${claimantSiteId} ${s?.name || s?.organisationName || ""}`);
    } else {
      console.log(
        `  no claimant site (${claimantSites.length} site(s) on the org); set CLAIMANT_SITE_ID to attribute one`,
      );
      for (const s of claimantSites) {
        console.log(`    #${s.id} active=${s.isActive} ${s.name || s.organisationName}`);
      }
    }
    console.log("Food (for people):");
    for (const item of RECORD.items) {
      console.log(`  ${item.name.padEnd(20)} ${item.kg} kg`);
    }
    console.log(`  ${"Total".padEnd(20)} ${totalKg} kg`);
    console.log(`Collected at: ${local(collectedAt, timeZone)} (${timeZone})`);

    if (duplicates.length && env.FORCE !== "1") {
      console.log("\nThis collection looks recorded already:");
      for (const d of duplicates) {
        console.log(`  LST-${String(d.id).padStart(5, "0")} ${d.totalQtyKg} kg`);
      }
      console.log("Nothing written. Re-run with FORCE=1 only if this is a second, separate collection.");
      return;
    }

    if (!apply) {
      console.log("\nPreview only. Re-run with APPLY=1 to create the listing and the completed collection.");
      return;
    }

    const now = utc(new Date());
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const listing = await client.query(
        `INSERT INTO food_listings (
           "siteId", "organisationId", "listingType", "recoveryPathway",
           "totalQtyKg", "remainingQtyKg",
           "pickupAddress", "pickupPostcode", "pickupLat", "pickupLng",
           "bestBefore", "pickupFromTime", "pickupByTime",
           "needsAmbient", "isSafeForDonation", "collectionNotes",
           status, "uniqueClaimantCount",
           "snapshotGroupId", "snapshotClusterId", "snapshotTerritoryId",
           "createdAt", "updatedAt"
         ) VALUES (
           $1, $2, 'HUMAN', 'FOOD_FOR_PEOPLE',
           $3, 0,
           $4, $5, $6, $7,
           $8, $9, $8,
           true, true, $10,
           'CLAIMED', 1,
           $11, $12, $13,
           $9, $14
         ) RETURNING id`,
        [
          site.id,
          site.organisationId,
          totalKg,
          site.address,
          site.postcode,
          site.latitude,
          site.longitude,
          utc(collectedAt),
          utc(pickupFrom),
          RECORD.note,
          providerSnapshot.groupId,
          providerSnapshot.clusterId,
          providerSnapshot.territoryId,
          now,
        ],
      );
      const listingId = listing.rows[0].id;

      const foodItemIds = [];
      for (const item of RECORD.items) {
        const row = await client.query(
          `INSERT INTO food_items ("listingId", name, "totalQtyKg", "remainingQtyKg", unit, category)
           VALUES ($1, $2, $3, 0, 'kg', $2) RETURNING id`,
          [listingId, item.name, item.kg],
        );
        foodItemIds.push(row.rows[0].id);
      }

      const claim = await client.query(
        `INSERT INTO food_claims (
           "listingId", "claimantOrgId", "claimantSiteId", "claimMode", status,
           "recoveryPathway", "providerConfirmedAt", "providerDidCollect",
           "confirmedAt", "collectedAt",
           "snapshotGroupId", "snapshotClusterId", "snapshotTerritoryId",
           "createdAt", "updatedAt"
         ) VALUES (
           $1, $2, $3, 'FULL', 'COLLECTED',
           'FOOD_FOR_PEOPLE', $4, true,
           $4, $4,
           $5, $6, $7,
           $8, $9
         ) RETURNING id`,
        [
          listingId,
          claimant.id,
          claimantSiteId,
          utc(collectedAt),
          claimantSnapshot.groupId,
          claimantSnapshot.clusterId,
          claimantSnapshot.territoryId,
          utc(pickupFrom),
          now,
        ],
      );
      const claimId = claim.rows[0].id;

      for (let index = 0; index < RECORD.items.length; index += 1) {
        await client.query(
          `INSERT INTO claim_items ("claimId", "foodItemId", "qtyKg") VALUES ($1, $2, $3)`,
          [claimId, foodItemIds[index], RECORD.items[index].kg],
        );
      }

      await client.query(
        `INSERT INTO restaurant_charity_support
           ("restaurantOrgId", "charityOrgId", "firstClaimedAt", "lastClaimedAt", "totalClaimsCount")
         VALUES ($1, $2, $3, $3, 1)
         ON CONFLICT ("restaurantOrgId", "charityOrgId")
         DO UPDATE SET "lastClaimedAt" = EXCLUDED."lastClaimedAt",
                       "totalClaimsCount" = restaurant_charity_support."totalClaimsCount" + 1`,
        [site.organisationId, claimant.id, utc(collectedAt)],
      );

      const activity = [
        [site.organisationId, "listing created", RECORD.note, null, pickupFrom],
        [claimant.id, "CLAIMED_FULL", `Full claim of ${totalKg}kg`, totalKg, pickupFrom],
        [claimant.id, "CLAIM_COLLECTED", `${totalKg}kg collected`, totalKg, collectedAt],
      ];
      for (const [actorOrgId, eventType, message, qtyKg, at] of activity) {
        await client.query(
          `INSERT INTO listing_activity ("listingId", "actorOrgId", "eventType", message, "qtyKg", "createdAt", "updatedAt")
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [listingId, actorOrgId, eventType, message, qtyKg, utc(at), now],
        );
      }

      await client.query("COMMIT");
      console.log(
        `\nDone. Created LST-${String(listingId).padStart(5, "0")} (listing #${listingId}) with claim #${claimId}: ${totalKg} kg collected by ${claimant.name}.`,
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
