/*
  Warnings:

  - Added the required column `batchId` to the `DispatchOffer` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
-- Local dev DB only has a handful of pre-existing rows; backfill batchId
-- with each row's own id as a placeholder before enforcing NOT NULL.
ALTER TABLE "DispatchOffer" ADD COLUMN     "batchId" TEXT;
UPDATE "DispatchOffer" SET "batchId" = "id" WHERE "batchId" IS NULL;
ALTER TABLE "DispatchOffer" ALTER COLUMN "batchId" SET NOT NULL;

-- AlterTable
ALTER TABLE "PlatformConfig" ADD COLUMN     "dispatchBatchSize" INTEGER NOT NULL DEFAULT 3,
ADD COLUMN     "quoteCollectionMinutes" INTEGER NOT NULL DEFAULT 5;

-- AlterTable
ALTER TABLE "RescueRequest" ADD COLUMN     "quoteCollectionDeadline" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "DispatchOffer_rescueRequestId_batchId_idx" ON "DispatchOffer"("rescueRequestId", "batchId");
