import { describe, it, expect } from 'vitest';
import { toMapboxCoord, fromMapboxCoord } from './mapboxCoords';

describe('mapboxCoords helpers', () => {
  describe('toMapboxCoord', () => {
    it('swaps { lat, lon } into GeoJSON [lon, lat] order', () => {
      // Bangalore: lat 12.9716, lon 77.5946
      expect(toMapboxCoord(12.9716, 77.5946)).toEqual([77.5946, 12.9716]);
    });

    it('handles zero coordinates', () => {
      expect(toMapboxCoord(0, 0)).toEqual([0, 0]);
    });

    it('handles negative coordinates (southern / western hemisphere)', () => {
      // Sydney: lat -33.8688, lon 151.2093
      expect(toMapboxCoord(-33.8688, 151.2093)).toEqual([151.2093, -33.8688]);
      // Rio: lat -22.9068, lon -43.1729
      expect(toMapboxCoord(-22.9068, -43.1729)).toEqual([-43.1729, -22.9068]);
    });

    it('handles extreme valid values', () => {
      expect(toMapboxCoord(90, 180)).toEqual([180, 90]);
      expect(toMapboxCoord(-90, -180)).toEqual([-180, -90]);
    });
  });

  describe('fromMapboxCoord', () => {
    it('unpacks GeoJSON [lon, lat] into { lat, lon }', () => {
      expect(fromMapboxCoord([77.5946, 12.9716])).toEqual({
        lat: 12.9716,
        lon: 77.5946,
      });
    });

    it('handles zero and negative coordinates', () => {
      expect(fromMapboxCoord([0, 0])).toEqual({ lat: 0, lon: 0 });
      expect(fromMapboxCoord([-43.1729, -22.9068])).toEqual({
        lat: -22.9068,
        lon: -43.1729,
      });
    });
  });

  describe('round-trip', () => {
    const samples: Array<{ lat: number; lon: number }> = [
      { lat: 0, lon: 0 },
      { lat: 12.9716, lon: 77.5946 },
      { lat: -33.8688, lon: 151.2093 },
      { lat: -22.9068, lon: -43.1729 },
      { lat: 51.5074, lon: -0.1278 },
      { lat: 90, lon: 180 },
      { lat: -90, lon: -180 },
    ];

    it('fromMapboxCoord(toMapboxCoord(lat, lon)) returns the original { lat, lon }', () => {
      for (const { lat, lon } of samples) {
        expect(fromMapboxCoord(toMapboxCoord(lat, lon))).toEqual({ lat, lon });
      }
    });

    it('toMapboxCoord(fromMapboxCoord([lon, lat])) returns the original tuple', () => {
      for (const { lat, lon } of samples) {
        const tuple: [number, number] = [lon, lat];
        const { lat: rLat, lon: rLon } = fromMapboxCoord(tuple);
        expect(toMapboxCoord(rLat, rLon)).toEqual(tuple);
      }
    });
  });
});
