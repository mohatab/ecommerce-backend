-- AlterEnum
ALTER TYPE "OrderStatus" ADD VALUE 'EXPIRED';

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "expired_at" TIMESTAMP(3),
ADD COLUMN     "expires_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "maintenance_leases" (
    "job" TEXT NOT NULL,
    "holder" TEXT NOT NULL,
    "acquired_at" TIMESTAMP(3) NOT NULL,
    "heartbeat_at" TIMESTAMP(3) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "maintenance_leases_pkey" PRIMARY KEY ("job")
);

-- CreateTable
CREATE TABLE "reconciliation_findings" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "payment_id" TEXT,
    "kind" TEXT NOT NULL,
    "detail" JSONB NOT NULL,
    "occurrences" INTEGER NOT NULL DEFAULT 1,
    "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reconciliation_findings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "reconciliation_findings_kind_resolved_at_idx" ON "reconciliation_findings"("kind", "resolved_at");

-- CreateIndex
CREATE UNIQUE INDEX "reconciliation_findings_order_id_kind_key" ON "reconciliation_findings"("order_id", "kind");

-- CreateIndex
CREATE INDEX "orders_status_expires_at_idx" ON "orders"("status", "expires_at");

-- CreateIndex
CREATE INDEX "payment_events_created_at_idx" ON "payment_events"("created_at");

-- CreateIndex
CREATE INDEX "refresh_tokens_expires_at_idx" ON "refresh_tokens"("expires_at");

-- AddForeignKey
ALTER TABLE "reconciliation_findings" ADD CONSTRAINT "reconciliation_findings_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Seed one lease row per job name, expired at the epoch.
-- Every acquire() is therefore an UPDATE whose predicate travels with the
-- write, so no code path ever needs to race on an INSERT.
INSERT INTO "maintenance_leases"
  ("job", "holder", "acquired_at", "heartbeat_at", "expires_at", "created_at", "updated_at")
VALUES
  ('order-expiry',           '', 'epoch', 'epoch', 'epoch', now(), now()),
  ('maintenance-purge',      '', 'epoch', 'epoch', 'epoch', now(), now()),
  ('payment-reconciliation', '', 'epoch', 'epoch', 'epoch', now(), now());
