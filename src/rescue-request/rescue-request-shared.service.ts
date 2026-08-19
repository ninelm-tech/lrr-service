import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { GeocodingService } from '../integrations/geocoding/geocoding.service';
import { UserRole } from '@prisma/client';

/**
 * Small shared helpers with no WhatsApp-flow state of their own, used by
 * two or more of the rescue-request services — kept here instead of on any
 * one of them so none has to depend on a sibling just to resolve a user or
 * format a location string.
 */
@Injectable()
export class RescueRequestSharedService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly geocodingService: GeocodingService,
  ) {}

  async findOrCreateCustomer(phoneNumber: string) {
    return this.prisma.user.upsert({
      where:  { phoneNumber },
      update: {},
      create: { phoneNumber, role: UserRole.CUSTOMER },
    });
  }

  /**
   * Operators were only ever given a raw Google Maps link for the pickup
   * point — no address, no area name, nothing readable without clicking
   * through. Reverse-geocodes so the message itself carries the full
   * picture (address if resolvable, map link always). Best-effort: a
   * failed/unconfigured geocode falls back to the map link alone rather
   * than blocking dispatch.
   */
  async formatLocationSection(lat: number, lon: number): Promise<string> {
    const address = await this.geocodingService.reverseGeocode(lat, lon);
    const mapLink = `https://maps.google.com/?q=${lat},${lon}`;
    return address ? `${address}\n📍 ${mapLink}` : mapLink;
  }
}
