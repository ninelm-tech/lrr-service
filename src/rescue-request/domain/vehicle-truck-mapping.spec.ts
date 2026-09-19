import { TruckClass, VehicleType } from '@prisma/client';
import {
  getEligibleTruckClasses,
  mapVehicleTypeReply,
  formatVehicleType,
} from './vehicle-truck-mapping';

describe('getEligibleTruckClasses', () => {
  it('maps SEDAN to light-duty and 10-tyre trucks', () => {
    expect(getEligibleTruckClasses(VehicleType.SEDAN)).toEqual([
      TruckClass.LIGHT_DUTY,
      TruckClass.TEN_TYRE,
    ]);
  });

  it('maps SUV to light-duty and 10-tyre trucks', () => {
    expect(getEligibleTruckClasses(VehicleType.SUV)).toEqual([
      TruckClass.LIGHT_DUTY,
      TruckClass.TEN_TYRE,
    ]);
  });

  it('maps ARMORED_LUXURY to low-bed and hiab trucks', () => {
    expect(getEligibleTruckClasses(VehicleType.ARMORED_LUXURY)).toEqual([
      TruckClass.LOW_BED,
      TruckClass.HIAB,
    ]);
  });

  it('maps HEAVY_TRAILER to low-bed and hiab trucks', () => {
    expect(getEligibleTruckClasses(VehicleType.HEAVY_TRAILER)).toEqual([
      TruckClass.LOW_BED,
      TruckClass.HIAB,
    ]);
  });
});

describe('mapVehicleTypeReply', () => {
  it('maps numbered replies 1-4 to the four vehicle types', () => {
    expect(mapVehicleTypeReply('1')).toBe(VehicleType.SEDAN);
    expect(mapVehicleTypeReply('2')).toBe(VehicleType.SUV);
    expect(mapVehicleTypeReply('3')).toBe(VehicleType.ARMORED_LUXURY);
    expect(mapVehicleTypeReply('4')).toBe(VehicleType.HEAVY_TRAILER);
  });

  it('maps text aliases case-insensitively', () => {
    expect(mapVehicleTypeReply('sedan')).toBe(VehicleType.SEDAN);
    expect(mapVehicleTypeReply('SUV')).toBe(VehicleType.SUV);
    expect(mapVehicleTypeReply('armored')).toBe(VehicleType.ARMORED_LUXURY);
    expect(mapVehicleTypeReply('armoured')).toBe(VehicleType.ARMORED_LUXURY);
    expect(mapVehicleTypeReply('armored luxury')).toBe(
      VehicleType.ARMORED_LUXURY,
    );
    expect(mapVehicleTypeReply('ARMOURED LUXURY')).toBe(
      VehicleType.ARMORED_LUXURY,
    );
    expect(mapVehicleTypeReply('luxury')).toBe(VehicleType.ARMORED_LUXURY);
    expect(mapVehicleTypeReply('trailer')).toBe(VehicleType.HEAVY_TRAILER);
    expect(mapVehicleTypeReply('heavy')).toBe(VehicleType.HEAVY_TRAILER);
    expect(mapVehicleTypeReply('HEAVY TRAILER')).toBe(
      VehicleType.HEAVY_TRAILER,
    );
  });

  it('returns undefined for unrecognised input', () => {
    expect(mapVehicleTypeReply('banana')).toBeUndefined();
    expect(mapVehicleTypeReply('5')).toBeUndefined();
  });
});

describe('formatVehicleType', () => {
  it('formats enum values as readable labels', () => {
    expect(formatVehicleType(VehicleType.SEDAN)).toBe('Sedan');
    expect(formatVehicleType(VehicleType.ARMORED_LUXURY)).toBe(
      'Armored/Luxury',
    );
    expect(formatVehicleType(VehicleType.HEAVY_TRAILER)).toBe('Heavy Trailer');
  });
});
