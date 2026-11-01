-- AlterTable
ALTER TABLE "User" ADD COLUMN     "whatsappExternalUserId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "User_whatsappExternalUserId_key" ON "User"("whatsappExternalUserId");
