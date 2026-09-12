-- CreateEnum
CREATE TYPE "MediaType" AS ENUM ('IMAGE', 'VIDEO', 'AUDIO');

-- AlterEnum
ALTER TYPE "RescueRequestStatus" ADD VALUE 'WAITING_FOR_MEDIA';

-- CreateTable
CREATE TABLE "RequestMedia" (
    "id" TEXT NOT NULL,
    "rescueRequestId" TEXT NOT NULL,
    "mediaType" "MediaType" NOT NULL,
    "s3Key" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RequestMedia_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RequestMedia_rescueRequestId_idx" ON "RequestMedia"("rescueRequestId");

-- AddForeignKey
ALTER TABLE "RequestMedia" ADD CONSTRAINT "RequestMedia_rescueRequestId_fkey" FOREIGN KEY ("rescueRequestId") REFERENCES "RescueRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
