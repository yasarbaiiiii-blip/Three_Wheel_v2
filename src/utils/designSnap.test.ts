import { describe, it, expect } from 'vitest';
import { snapToGrid, findSnapCandidate } from './designSnap';

describe('designSnap', () => {
  it('snaps coordinates to grid spacing correctly', () => {
    const pt1 = { northM: 1.234, eastM: 2.378 };
    
    // Spacing 0.1m
    const snapped1 = snapToGrid(pt1, 0.1);
    expect(snapped1.northM).toBeCloseTo(1.2, 3);
    expect(snapped1.eastM).toBeCloseTo(2.4, 3);

    // Spacing 0.5m
    const snapped2 = snapToGrid(pt1, 0.5);
    expect(snapped2.northM).toBeCloseTo(1.0, 3);
    expect(snapped2.eastM).toBeCloseTo(2.5, 3);
  });

  it('preserves 0.001m precision', () => {
    const pt2 = { northM: 1.0005, eastM: 2.0004 };
    const snapped3 = snapToGrid(pt2, 0.001);
    expect(snapped3.northM).toBe(1.001);
    expect(snapped3.eastM).toBe(2.000);
  });

  it('finds snap candidate endpoints within radius', () => {
    const lines = [
      {
        id: '1',
        label: 'l1',
        layer: 'marking' as const,
        from: { id: 1, x: 10, y: 20 },
        to: { id: 2, x: 15, y: 25 },
        width: 0.1,
      },
    ];

    // Pointer is close to (10, 20) -> 0.05m away.
    // At zoom=1, pxPerM=100, radiusPx=12, radiusM = 12 / 100 = 0.12m.
    // 0.05m < 0.12m -> should snap.
    const ptrClose = { northM: 10.05, eastM: 20.0 };
    const snapped = findSnapCandidate(ptrClose, lines, 1.0, 100, 12);
    expect(snapped).not.toBeNull();
    expect(snapped?.northM).toBe(10);
    expect(snapped?.eastM).toBe(20);

    // Pointer is too far (0.15m away) -> 0.15m > 0.12m -> should not snap.
    const ptrFar = { northM: 10.15, eastM: 20.0 };
    const snappedFar = findSnapCandidate(ptrFar, lines, 1.0, 100, 12);
    expect(snappedFar).toBeNull();
  });
});
