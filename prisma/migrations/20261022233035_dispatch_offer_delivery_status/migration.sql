-- AlterTable
ALTER TABLE "DispatchOffer" ADD COLUMN     "deliveryErrorCode" INTEGER,
ADD COLUMN     "deliveryStatus" TEXT,
ADD COLUMN     "twilioMessageSid" TEXT;
