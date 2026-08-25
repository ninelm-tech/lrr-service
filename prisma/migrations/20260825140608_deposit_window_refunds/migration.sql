-- CreateEnum
CREATE TYPE "RefundStatus" AS ENUM ('NONE', 'ELIGIBLE', 'PENDING', 'COMPLETED', 'FAILED');

-- AlterTable
ALTER TABLE "RescueRequest" ADD COLUMN     "depositRefundId" INTEGER,
ADD COLUMN     "depositRefundStatus" "RefundStatus" NOT NULL DEFAULT 'NONE';
