-- AlterTable
ALTER TABLE "Rating" ADD COLUMN     "flagged" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "flaggedAt" TIMESTAMP(3),
ADD COLUMN     "flaggedResolvedAt" TIMESTAMP(3);
