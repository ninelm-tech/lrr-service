/*
  Warnings:

  - You are about to drop the column `codeHash` on the `PhoneVerification` table. All the data in the column will be lost.
  - Added the required column `pinId` to the `PhoneVerification` table without a default value. This is not possible if the table is not empty.

*/
-- Rows here are short-lived (10-minute TTL) verification attempts, not data
-- worth preserving across the codeHash -> pinId format change. Clearing
-- first so this migration succeeds even if the table is non-empty at
-- deploy time (an in-flight verification just needs to be retried).
DELETE FROM "PhoneVerification";

-- AlterTable
ALTER TABLE "PhoneVerification" DROP COLUMN "codeHash",
ADD COLUMN     "pinId" TEXT NOT NULL;
