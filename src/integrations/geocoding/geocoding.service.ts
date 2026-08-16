import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class GeocodingService {
  constructor(private readonly configService: ConfigService) {}

  /**
   * Reverse-geocodes coordinates into a human-readable address, so an
   * operator sees a real address/area instead of only a raw map link.
   * Best-effort: returns null on any failure (missing key, API error,
   * network issue) — dispatch must never be blocked by this.
   */
  async reverseGeocode(lat: number, lng: number): Promise<string | null> {
    const apiKey = this.configService.get<string>('GOOGLE_MAPS_API_KEY');
    if (!apiKey) return null;

    try {
      const res = await fetch(
        `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${apiKey}`,
      );
      const data = (await res.json()) as any;
      if (data.status !== 'OK' || !data.results?.[0]?.formatted_address) return null;
      return data.results[0].formatted_address as string;
    } catch (error) {
      console.error('Reverse geocoding failed:', error);
      return null;
    }
  }
}
