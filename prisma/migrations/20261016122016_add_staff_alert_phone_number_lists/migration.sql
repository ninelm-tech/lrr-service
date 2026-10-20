-- AlterTable: add the two new list columns first
ALTER TABLE "PlatformConfig"
ADD COLUMN     "disputeAlertPhoneNumbers" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "newRequestAlertPhoneNumbers" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- Carry forward any existing single dispute-alert number into the new list
-- instead of dropping it, since it's live config for a production platform.
UPDATE "PlatformConfig"
SET "disputeAlertPhoneNumbers" = ARRAY["disputeAlertPhoneNumber"]
WHERE "disputeAlertPhoneNumber" IS NOT NULL;

-- Now safe to drop the old single-value column.
ALTER TABLE "PlatformConfig" DROP COLUMN "disputeAlertPhoneNumber";
