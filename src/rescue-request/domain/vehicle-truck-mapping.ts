import { TruckClass, VehicleType } from '@prisma/client';

const VEHICLE_TYPE_TO_TRUCK_CLASSES: Record<VehicleType, TruckClass[]> = {
  [VehicleType.SEDAN]:          [TruckClass.LIGHT_DUTY, TruckClass.TEN_TYRE],
  [VehicleType.SUV]:            [TruckClass.LIGHT_DUTY, TruckClass.TEN_TYRE],
  [VehicleType.ARMORED_LUXURY]: [TruckClass.LOW_BED, TruckClass.HIAB],
  [VehicleType.HEAVY_TRAILER]:  [TruckClass.LOW_BED, TruckClass.HIAB],
};

export function getEligibleTruckClasses(vehicleType: VehicleType): TruckClass[] {
  return VEHICLE_TYPE_TO_TRUCK_CLASSES[vehicleType];
}

const REPLY_TO_VEHICLE_TYPE: Record<string, VehicleType> = {
  '1': VehicleType.SEDAN,
  '2': VehicleType.SUV,
  '3': VehicleType.ARMORED_LUXURY,
  '4': VehicleType.HEAVY_TRAILER,
  'sedan': VehicleType.SEDAN,
  'suv': VehicleType.SUV,
  'armored': VehicleType.ARMORED_LUXURY,
  'armoured': VehicleType.ARMORED_LUXURY,
  'luxury': VehicleType.ARMORED_LUXURY,
  'armored luxury': VehicleType.ARMORED_LUXURY,
  'armoured luxury': VehicleType.ARMORED_LUXURY,
  'trailer': VehicleType.HEAVY_TRAILER,
  'heavy trailer': VehicleType.HEAVY_TRAILER,
  'heavy': VehicleType.HEAVY_TRAILER,
};

export function mapVehicleTypeReply(message: string): VehicleType | undefined {
  return REPLY_TO_VEHICLE_TYPE[message.trim().toLowerCase()];
}

const VEHICLE_TYPE_LABELS: Record<VehicleType, string> = {
  [VehicleType.SEDAN]:          'Sedan',
  [VehicleType.SUV]:            'SUV',
  [VehicleType.ARMORED_LUXURY]: 'Armored/Luxury',
  [VehicleType.HEAVY_TRAILER]:  'Heavy Trailer',
};

export function formatVehicleType(vehicleType: VehicleType): string {
  return VEHICLE_TYPE_LABELS[vehicleType];
}
