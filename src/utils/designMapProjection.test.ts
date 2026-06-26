import { describe, it, expect } from 'vitest';
import { projectDesignToGps, projectGpsToDesignMeters } from './designTransform';
import type { DesignVertex, DesignPreviewAnchor } from '../types/designDocument';

describe('Design Map Projection Tests (Phase 4)', () => {
  const anchor: DesignPreviewAnchor = {
    mode: 'rover_latched',
    lat: 12.9716, // Bangalore lat
    lon: 77.5946, // Bangalore lon
  };

  it('should project a vertex to GPS and reconstruct it back within ±0.05m tolerance', () => {
    const vertices: DesignVertex[] = [
      { northM: 0, eastM: 0 },
      { northM: 10, eastM: -15 },
      { northM: -100, eastM: 250 },
      { northM: 45.123, eastM: 89.456 },
    ];

    for (const v of vertices) {
      const gps = projectDesignToGps(v, anchor);
      const reconstructed = projectGpsToDesignMeters(gps.lat, gps.lon, anchor);

      const dN = Math.abs(reconstructed.northM - v.northM);
      const dE = Math.abs(reconstructed.eastM - v.eastM);

      expect(dN).toBeLessThan(0.001); // Standard projection math is highly precise locally
      expect(dE).toBeLessThan(0.001);
      expect(Math.hypot(dN, dE)).toBeLessThan(0.05); // Within ±0.05m constraint
    }
  });

  it('should verify coordinate swap is resolved correctly (positive North maps to larger Lat, positive East maps to larger Lon)', () => {
    const origin: DesignVertex = { northM: 0, eastM: 0 };
    const northPt: DesignVertex = { northM: 10, eastM: 0 };
    const eastPt: DesignVertex = { northM: 0, eastM: 10 };

    const originGps = projectDesignToGps(origin, anchor);
    const northGps = projectDesignToGps(northPt, anchor);
    const eastGps = projectDesignToGps(eastPt, anchor);

    // North = increase latitude
    expect(northGps.lat).toBeGreaterThan(originGps.lat);
    expect(northGps.lon).toBe(originGps.lon);

    // East = increase longitude
    expect(eastGps.lon).toBeGreaterThan(originGps.lon);
    expect(eastGps.lat).toBe(originGps.lat);
  });
});
