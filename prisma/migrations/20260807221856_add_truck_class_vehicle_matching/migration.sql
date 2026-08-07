-- CreateEnum
CREATE TYPE "TruckClass" AS ENUM ('LIGHT_DUTY', 'TEN_TYRE', 'LOW_BED', 'HIAB');

-- CreateEnum
CREATE TYPE "VehicleType" AS ENUM ('SEDAN', 'SUV', 'ARMORED_LUXURY', 'HEAVY_TRAILER');

-- AlterTable
ALTER TABLE "Operator" ADD COLUMN     "truckClasses" "TruckClass"[] DEFAULT ARRAY[]::"TruckClass"[];

-- AlterTable
ALTER TABLE "RescueRequest" ADD COLUMN     "destination" TEXT,
ADD COLUMN     "vehicleType" "VehicleType";

-- AlterTable
ALTER TABLE "WhatsAppSession" ADD COLUMN     "destination" TEXT,
ADD COLUMN     "vehicleType" TEXT;
