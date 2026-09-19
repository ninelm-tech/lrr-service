-- CreateEnum
CREATE TYPE "MediaContext" AS ENUM ('INITIAL', 'COMPLETION', 'DISPUTE');

-- AlterTable
ALTER TABLE "RequestMedia" ADD COLUMN     "context" "MediaContext" NOT NULL DEFAULT 'INITIAL',
ADD COLUMN     "uploadedByRole" "UserRole" NOT NULL DEFAULT 'CUSTOMER';

-- CreateIndex
CREATE INDEX "RequestMedia_rescueRequestId_context_uploadedByRole_idx" ON "RequestMedia"("rescueRequestId", "context", "uploadedByRole");
