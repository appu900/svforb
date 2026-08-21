-- Enterprise: Group -> Cluster -> Site hierarchy, Territory dimension,
-- offline contract/invoicing, and historical classification snapshots.

CREATE TYPE "BillingFrequency" AS ENUM ('MONTHLY', 'QUARTERLY', 'ANNUAL');
CREATE TYPE "ContractStatus"   AS ENUM ('DRAFT', 'ACTIVE', 'EXPIRED', 'TERMINATED');
CREATE TYPE "InvoiceStatus"    AS ENUM ('DRAFT', 'ISSUED', 'PAID', 'OVERDUE', 'CANCELLED');

-- ── Structure ────────────────────────────────────────────────────────────────

CREATE TABLE "enterprise_groups" (
    "id" SERIAL NOT NULL,
    "organisationId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "enterprise_groups_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "enterprise_groups_organisationId_name_key" ON "enterprise_groups"("organisationId", "name");
CREATE INDEX "enterprise_groups_organisationId_isActive_idx" ON "enterprise_groups"("organisationId", "isActive");
ALTER TABLE "enterprise_groups" ADD CONSTRAINT "enterprise_groups_organisationId_fkey"
  FOREIGN KEY ("organisationId") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "clusters" (
    "id" SERIAL NOT NULL,
    "organisationId" INTEGER NOT NULL,
    "groupId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "clusters_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "clusters_organisationId_name_key" ON "clusters"("organisationId", "name");
CREATE INDEX "clusters_organisationId_isActive_idx" ON "clusters"("organisationId", "isActive");
CREATE INDEX "clusters_groupId_idx" ON "clusters"("groupId");
ALTER TABLE "clusters" ADD CONSTRAINT "clusters_organisationId_fkey"
  FOREIGN KEY ("organisationId") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "clusters" ADD CONSTRAINT "clusters_groupId_fkey"
  FOREIGN KEY ("groupId") REFERENCES "enterprise_groups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "cluster_sites" (
    "id" SERIAL NOT NULL,
    "clusterId" INTEGER NOT NULL,
    "siteId" INTEGER NOT NULL,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assignedBy" INTEGER NOT NULL,
    CONSTRAINT "cluster_sites_pkey" PRIMARY KEY ("id")
);
-- one cluster per site: strict nesting enforced by the database
CREATE UNIQUE INDEX "cluster_sites_siteId_key" ON "cluster_sites"("siteId");
CREATE INDEX "cluster_sites_clusterId_idx" ON "cluster_sites"("clusterId");
ALTER TABLE "cluster_sites" ADD CONSTRAINT "cluster_sites_clusterId_fkey"
  FOREIGN KEY ("clusterId") REFERENCES "clusters"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "cluster_sites" ADD CONSTRAINT "cluster_sites_siteId_fkey"
  FOREIGN KEY ("siteId") REFERENCES "sites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "territories" (
    "id" SERIAL NOT NULL,
    "organisationId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "territories_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "territories_organisationId_name_key" ON "territories"("organisationId", "name");
CREATE INDEX "territories_organisationId_isActive_idx" ON "territories"("organisationId", "isActive");
ALTER TABLE "territories" ADD CONSTRAINT "territories_organisationId_fkey"
  FOREIGN KEY ("organisationId") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "territory_sites" (
    "id" SERIAL NOT NULL,
    "territoryId" INTEGER NOT NULL,
    "siteId" INTEGER NOT NULL,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assignedBy" INTEGER NOT NULL,
    CONSTRAINT "territory_sites_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "territory_sites_siteId_key" ON "territory_sites"("siteId");
CREATE INDEX "territory_sites_territoryId_idx" ON "territory_sites"("territoryId");
ALTER TABLE "territory_sites" ADD CONSTRAINT "territory_sites_territoryId_fkey"
  FOREIGN KEY ("territoryId") REFERENCES "territories"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "territory_sites" ADD CONSTRAINT "territory_sites_siteId_fkey"
  FOREIGN KEY ("siteId") REFERENCES "sites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Offline billing ──────────────────────────────────────────────────────────

CREATE TABLE "enterprise_contracts" (
    "id" SERIAL NOT NULL,
    "organisationId" INTEGER NOT NULL,
    "ratePerSiteCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'AUD',
    "billingFrequency" "BillingFrequency" NOT NULL DEFAULT 'MONTHLY',
    "contractedSiteCount" INTEGER,
    "taxRatePercent" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3),
    "status" "ContractStatus" NOT NULL DEFAULT 'ACTIVE',
    "paymentTermsDays" INTEGER NOT NULL DEFAULT 30,
    "nextInvoiceOn" TIMESTAMP(3),
    "notes" TEXT,
    "createdBy" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "enterprise_contracts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "enterprise_contracts_organisationId_key" ON "enterprise_contracts"("organisationId");
CREATE INDEX "enterprise_contracts_status_nextInvoiceOn_idx" ON "enterprise_contracts"("status", "nextInvoiceOn");
ALTER TABLE "enterprise_contracts" ADD CONSTRAINT "enterprise_contracts_organisationId_fkey"
  FOREIGN KEY ("organisationId") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "enterprise_invoices" (
    "id" SERIAL NOT NULL,
    "invoiceNumber" TEXT NOT NULL,
    "organisationId" INTEGER NOT NULL,
    "contractId" INTEGER NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "siteCount" INTEGER NOT NULL,
    "ratePerSiteCents" INTEGER NOT NULL,
    "subtotalCents" INTEGER NOT NULL,
    "taxCents" INTEGER NOT NULL DEFAULT 0,
    "totalCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'DRAFT',
    "issuedAt" TIMESTAMP(3),
    "dueAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "paidBy" INTEGER,
    "paymentReference" TEXT,
    "notes" TEXT,
    "pdfUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "enterprise_invoices_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "enterprise_invoices_invoiceNumber_key" ON "enterprise_invoices"("invoiceNumber");
-- stops the cron double-invoicing the same period
CREATE UNIQUE INDEX "enterprise_invoices_contractId_periodStart_key" ON "enterprise_invoices"("contractId", "periodStart");
CREATE INDEX "enterprise_invoices_organisationId_periodStart_idx" ON "enterprise_invoices"("organisationId", "periodStart");
CREATE INDEX "enterprise_invoices_status_dueAt_idx" ON "enterprise_invoices"("status", "dueAt");
ALTER TABLE "enterprise_invoices" ADD CONSTRAINT "enterprise_invoices_organisationId_fkey"
  FOREIGN KEY ("organisationId") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "enterprise_invoices" ADD CONSTRAINT "enterprise_invoices_contractId_fkey"
  FOREIGN KEY ("contractId") REFERENCES "enterprise_contracts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── Historical classification (no FKs: a snapshot must outlive its cluster) ───

ALTER TABLE "food_listings"
  ADD COLUMN "snapshotGroupId" INTEGER,
  ADD COLUMN "snapshotClusterId" INTEGER,
  ADD COLUMN "snapshotTerritoryId" INTEGER;
CREATE INDEX "food_listings_snapshotGroupId_idx" ON "food_listings"("snapshotGroupId");
CREATE INDEX "food_listings_snapshotClusterId_idx" ON "food_listings"("snapshotClusterId");
CREATE INDEX "food_listings_snapshotTerritoryId_idx" ON "food_listings"("snapshotTerritoryId");

ALTER TABLE "food_claims"
  ADD COLUMN "snapshotGroupId" INTEGER,
  ADD COLUMN "snapshotClusterId" INTEGER,
  ADD COLUMN "snapshotTerritoryId" INTEGER;
CREATE INDEX "food_claims_snapshotGroupId_idx" ON "food_claims"("snapshotGroupId");
CREATE INDEX "food_claims_snapshotClusterId_idx" ON "food_claims"("snapshotClusterId");
CREATE INDEX "food_claims_snapshotTerritoryId_idx" ON "food_claims"("snapshotTerritoryId");
