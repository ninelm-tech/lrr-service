/*
  Warnings:

  - You are about to drop the column `accountNumber` on the `Operator` table. All the data in the column will be lost.
  - You are about to drop the column `bankCode` on the `Operator` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "Operator" DROP COLUMN "accountNumber",
DROP COLUMN "bankCode",
ADD COLUMN     "accountNumberLast4" TEXT;
