-- AlterTable
--
-- Hand-edited. Prisma generated a bare `ADD COLUMN ... NOT NULL`, which fails
-- on any populated table ("column contains null values") — empty CI and prod
-- would have passed while staging broke. Adding with a default backfills the
-- existing rows; dropping it immediately afterwards leaves the column with no
-- default, so new offers must still state their round explicitly.
--
-- -1 is deliberately a round no request can occupy: RescueRequest.dispatchRound
-- starts at 0 and only increases, so a pre-migration offer can never be
-- mistaken for part of a live round.
ALTER TABLE "DispatchOffer" ADD COLUMN "dispatchRound" INTEGER NOT NULL DEFAULT -1;
ALTER TABLE "DispatchOffer" ALTER COLUMN "dispatchRound" DROP DEFAULT;

-- AlterTable
ALTER TABLE "RescueRequest" ADD COLUMN     "biddingClosedAt" TIMESTAMP(3),
ADD COLUMN     "confirmationDueAt" TIMESTAMP(3),
ADD COLUMN     "depositRemindersSent" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "depositWindowExpiresAt" TIMESTAMP(3),
ADD COLUMN     "dispatchRound" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "offeredOperatorIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "quoteSelectionExpiresAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "RescueRequest_depositWindowExpiresAt_idx" ON "RescueRequest"("depositWindowExpiresAt");

-- CreateIndex
CREATE INDEX "RescueRequest_quoteCollectionDeadline_idx" ON "RescueRequest"("quoteCollectionDeadline");

-- CreateIndex
CREATE INDEX "RescueRequest_quoteSelectionExpiresAt_idx" ON "RescueRequest"("quoteSelectionExpiresAt");

-- CreateIndex
CREATE INDEX "RescueRequest_confirmationDueAt_idx" ON "RescueRequest"("confirmationDueAt");
