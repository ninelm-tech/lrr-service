-- AlterTable
ALTER TABLE "Operator" ADD COLUMN     "whatsappEnabled" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "RescueRequest" ADD COLUMN     "needsManualAssignment" BOOLEAN NOT NULL DEFAULT false;
