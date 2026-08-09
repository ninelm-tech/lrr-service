-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "DispatchOfferStatus" ADD VALUE 'QUOTED';
ALTER TYPE "DispatchOfferStatus" ADD VALUE 'SELECTED_PENDING_PAYMENT';
ALTER TYPE "DispatchOfferStatus" ADD VALUE 'NOT_SELECTED';

-- AlterTable
ALTER TABLE "DispatchOffer" ADD COLUMN     "quotedPrice" INTEGER;

-- AlterTable
ALTER TABLE "RescueRequest" ADD COLUMN     "serviceFeeAmount" INTEGER;

-- CreateTable
CREATE TABLE "PlatformConfig" (
    "id" TEXT NOT NULL,
    "serviceFeePercent" DECIMAL(65,30) NOT NULL DEFAULT 10.0,
    "depositPercent" DECIMAL(65,30) NOT NULL DEFAULT 10.0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformConfig_pkey" PRIMARY KEY ("id")
);

-- Seed the one PlatformConfig row
INSERT INTO "PlatformConfig" ("id", "serviceFeePercent", "depositPercent", "updatedAt")
VALUES ('default', 10.0, 10.0, CURRENT_TIMESTAMP);
