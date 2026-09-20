-- AlterTable
ALTER TABLE "Operator" ADD COLUMN     "isTest" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "PlatformConfig" ADD COLUMN     "testCustomerPhoneNumbers" TEXT[] DEFAULT ARRAY[]::TEXT[];
