/*
  Warnings:

  - You are about to drop the column `userId` on the `Operator` table. All the data in the column will be lost.

*/
-- CreateEnum
CREATE TYPE "OperatorMemberRole" AS ENUM ('OWNER', 'MANAGER', 'DISPATCHER', 'DRIVER', 'STAFF');

-- DropForeignKey
ALTER TABLE "Operator" DROP CONSTRAINT "Operator_userId_fkey";

-- DropIndex
DROP INDEX "Operator_userId_key";

-- AlterTable
ALTER TABLE "Operator" DROP COLUMN "userId";

-- CreateTable
CREATE TABLE "OperatorMember" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "operatorId" TEXT NOT NULL,
    "role" "OperatorMemberRole" NOT NULL DEFAULT 'STAFF',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OperatorMember_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OperatorMember_operatorId_idx" ON "OperatorMember"("operatorId");

-- CreateIndex
CREATE INDEX "OperatorMember_userId_idx" ON "OperatorMember"("userId");

-- CreateIndex
CREATE INDEX "OperatorMember_role_idx" ON "OperatorMember"("role");

-- CreateIndex
CREATE UNIQUE INDEX "OperatorMember_userId_operatorId_key" ON "OperatorMember"("userId", "operatorId");

-- AddForeignKey
ALTER TABLE "OperatorMember" ADD CONSTRAINT "OperatorMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OperatorMember" ADD CONSTRAINT "OperatorMember_operatorId_fkey" FOREIGN KEY ("operatorId") REFERENCES "Operator"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
