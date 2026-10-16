-- AlterTable
ALTER TABLE "DispatchOffer" ADD COLUMN     "depositPercentSnapshot" DECIMAL(65,30);

-- AlterTable
ALTER TABLE "Operator" ADD COLUMN     "depositPercentOverride" DECIMAL(65,30);
