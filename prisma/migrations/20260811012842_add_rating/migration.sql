-- CreateEnum
CREATE TYPE "RatingDirection" AS ENUM ('MOTORIST_TO_OPERATOR', 'OPERATOR_TO_MOTORIST');

-- CreateTable
CREATE TABLE "Rating" (
    "id" TEXT NOT NULL,
    "rescueRequestId" TEXT NOT NULL,
    "direction" "RatingDirection" NOT NULL,
    "operatorId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "comment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Rating_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Rating_operatorId_idx" ON "Rating"("operatorId");

-- CreateIndex
CREATE INDEX "Rating_customerId_idx" ON "Rating"("customerId");

-- CreateIndex
CREATE UNIQUE INDEX "Rating_rescueRequestId_direction_key" ON "Rating"("rescueRequestId", "direction");

-- AddForeignKey
ALTER TABLE "Rating" ADD CONSTRAINT "Rating_rescueRequestId_fkey" FOREIGN KEY ("rescueRequestId") REFERENCES "RescueRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Rating" ADD CONSTRAINT "Rating_operatorId_fkey" FOREIGN KEY ("operatorId") REFERENCES "Operator"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Rating" ADD CONSTRAINT "Rating_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
