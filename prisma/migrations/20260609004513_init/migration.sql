-- CreateEnum
CREATE TYPE "SubscriptionPlan" AS ENUM ('INDIVIDUAL', 'COMMERCIAL');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('ACTIVE', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "DispatchOfferStatus" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED', 'TIMED_OUT');

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('CUSTOMER', 'OPERATOR', 'ADMIN', 'SUPER_ADMIN');

-- CreateEnum
CREATE TYPE "OperatorMemberRole" AS ENUM ('OWNER', 'MANAGER', 'DISPATCHER', 'DRIVER', 'STAFF');

-- CreateEnum
CREATE TYPE "OperatorType" AS ENUM ('TOW_TRUCK', 'MECHANIC', 'FUEL_DELIVERY', 'TYRE_REPAIR', 'BATTERY_JUMPSTART');

-- CreateEnum
CREATE TYPE "OperatorStatus" AS ENUM ('PENDING', 'ACTIVE', 'INACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "RescueRequestStatus" AS ENUM ('WAITING_FOR_LOCATION', 'WAITING_FOR_ISSUE_TYPE', 'WAITING_FOR_DEPOSIT', 'DISPATCHING', 'OPERATOR_ASSIGNED', 'IN_PROGRESS', 'ARRIVED', 'COMPLETED', 'CANCELLED', 'STALLED');

-- CreateEnum
CREATE TYPE "IssueType" AS ENUM ('BREAKDOWN', 'ACCIDENT', 'FLAT_TYRE', 'FUEL');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT,
    "phoneNumber" TEXT,
    "passwordHash" TEXT,
    "name" TEXT,
    "role" "UserRole" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Operator" (
    "id" TEXT NOT NULL,
    "type" "OperatorType" NOT NULL DEFAULT 'TOW_TRUCK',
    "businessName" TEXT NOT NULL,
    "contactName" TEXT NOT NULL,
    "phoneNumber" TEXT NOT NULL,
    "email" TEXT,
    "address" TEXT NOT NULL,
    "latitude" DECIMAL(65,30) NOT NULL,
    "longitude" DECIMAL(65,30) NOT NULL,
    "serviceRadius" INTEGER NOT NULL DEFAULT 10,
    "status" "OperatorStatus" NOT NULL DEFAULT 'PENDING',
    "isAvailable" BOOLEAN NOT NULL DEFAULT true,
    "verifiedAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Operator_pkey" PRIMARY KEY ("id")
);

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

-- CreateTable
CREATE TABLE "RescueRequest" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "status" "RescueRequestStatus" NOT NULL DEFAULT 'WAITING_FOR_LOCATION',
    "latitude" DECIMAL(65,30),
    "longitude" DECIMAL(65,30),
    "issueType" "IssueType",
    "depositPaid" BOOLEAN NOT NULL DEFAULT false,
    "depositAmount" INTEGER,
    "depositReference" TEXT,
    "balancePaid" BOOLEAN NOT NULL DEFAULT false,
    "balanceAmount" INTEGER,
    "balanceReference" TEXT,
    "assignedOperatorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RescueRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DispatchOffer" (
    "id" TEXT NOT NULL,
    "rescueRequestId" TEXT NOT NULL,
    "operatorId" TEXT NOT NULL,
    "status" "DispatchOfferStatus" NOT NULL DEFAULT 'PENDING',
    "offeredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "respondedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DispatchOffer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WhatsAppSession" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'IDLE',
    "latitude" DECIMAL(65,30),
    "longitude" DECIMAL(65,30),
    "issueType" TEXT,
    "rescueRequestId" TEXT,
    "depositReference" TEXT,
    "dispatchRound" INTEGER NOT NULL DEFAULT 0,
    "offeredOperatorIds" TEXT NOT NULL DEFAULT '[]',
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WhatsAppSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Subscription" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "plan" "SubscriptionPlan" NOT NULL,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'ACTIVE',
    "paystackCustomerCode" TEXT,
    "paystackSubscriptionCode" TEXT,
    "monthlyAmountKobo" INTEGER NOT NULL,
    "towsIncludedPerMonth" INTEGER NOT NULL DEFAULT 2,
    "towsUsedThisMonth" INTEGER NOT NULL DEFAULT 0,
    "currentPeriodStart" TIMESTAMP(3) NOT NULL,
    "currentPeriodEnd" TIMESTAMP(3) NOT NULL,
    "vehicleRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_phoneNumber_key" ON "User"("phoneNumber");

-- CreateIndex
CREATE INDEX "User_role_idx" ON "User"("role");

-- CreateIndex
CREATE INDEX "User_phoneNumber_idx" ON "User"("phoneNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Operator_phoneNumber_key" ON "Operator"("phoneNumber");

-- CreateIndex
CREATE INDEX "Operator_status_idx" ON "Operator"("status");

-- CreateIndex
CREATE INDEX "Operator_type_idx" ON "Operator"("type");

-- CreateIndex
CREATE INDEX "Operator_latitude_longitude_idx" ON "Operator"("latitude", "longitude");

-- CreateIndex
CREATE INDEX "OperatorMember_operatorId_idx" ON "OperatorMember"("operatorId");

-- CreateIndex
CREATE INDEX "OperatorMember_userId_idx" ON "OperatorMember"("userId");

-- CreateIndex
CREATE INDEX "OperatorMember_role_idx" ON "OperatorMember"("role");

-- CreateIndex
CREATE UNIQUE INDEX "OperatorMember_userId_operatorId_key" ON "OperatorMember"("userId", "operatorId");

-- CreateIndex
CREATE INDEX "RescueRequest_customerId_idx" ON "RescueRequest"("customerId");

-- CreateIndex
CREATE INDEX "RescueRequest_status_idx" ON "RescueRequest"("status");

-- CreateIndex
CREATE INDEX "RescueRequest_createdAt_idx" ON "RescueRequest"("createdAt");

-- CreateIndex
CREATE INDEX "RescueRequest_depositReference_idx" ON "RescueRequest"("depositReference");

-- CreateIndex
CREATE INDEX "RescueRequest_balanceReference_idx" ON "RescueRequest"("balanceReference");

-- CreateIndex
CREATE INDEX "DispatchOffer_rescueRequestId_idx" ON "DispatchOffer"("rescueRequestId");

-- CreateIndex
CREATE INDEX "DispatchOffer_operatorId_idx" ON "DispatchOffer"("operatorId");

-- CreateIndex
CREATE INDEX "DispatchOffer_status_idx" ON "DispatchOffer"("status");

-- CreateIndex
CREATE UNIQUE INDEX "WhatsAppSession_userId_key" ON "WhatsAppSession"("userId");

-- CreateIndex
CREATE INDEX "Subscription_userId_idx" ON "Subscription"("userId");

-- CreateIndex
CREATE INDEX "Subscription_status_idx" ON "Subscription"("status");

-- CreateIndex
CREATE INDEX "Subscription_currentPeriodEnd_idx" ON "Subscription"("currentPeriodEnd");

-- AddForeignKey
ALTER TABLE "OperatorMember" ADD CONSTRAINT "OperatorMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OperatorMember" ADD CONSTRAINT "OperatorMember_operatorId_fkey" FOREIGN KEY ("operatorId") REFERENCES "Operator"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RescueRequest" ADD CONSTRAINT "RescueRequest_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RescueRequest" ADD CONSTRAINT "RescueRequest_assignedOperatorId_fkey" FOREIGN KEY ("assignedOperatorId") REFERENCES "Operator"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DispatchOffer" ADD CONSTRAINT "DispatchOffer_rescueRequestId_fkey" FOREIGN KEY ("rescueRequestId") REFERENCES "RescueRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DispatchOffer" ADD CONSTRAINT "DispatchOffer_operatorId_fkey" FOREIGN KEY ("operatorId") REFERENCES "Operator"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhatsAppSession" ADD CONSTRAINT "WhatsAppSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
