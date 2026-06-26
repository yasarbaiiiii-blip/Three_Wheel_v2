/**
 * designSnap.ts — Phase 2 grid snap utilities.
 */

import type { DesignVertex } from '../types/designDocument';

/**
 * Snap a DesignVertex to grid spacing in metres.
 * Enforces a quantum precision of 0.001m (1mm).
 */
export function snapToGrid(vertex: DesignVertex, spacingM: number): DesignVertex {
  if (spacingM <= 0) return {
    northM: Math.round(vertex.northM * 1000) / 1000,
    eastM: Math.round(vertex.eastM * 1000) / 1000,
  };

  const snap = (val: number) => {
    const divided = val / spacingM;
    const rounded = Math.round(divided + (divided >= 0 ? 1e-9 : -1e-9));
    return Math.round(rounded * spacingM * 1000) / 1000;
  };

  return {
    northM: snap(vertex.northM),
    eastM: snap(vertex.eastM),
  };
}

/**
 * Find a snap candidate (endpoint of existing lines) within a screen pixel radius.
 * Returns the DesignVertex of the snap candidate if found, or null.
 */
export function findSnapCandidate(
  pointer: DesignVertex,
  lines: import('../types/plan').PlanLine[],
  zoom: number,
  pxPerM: number = 100,
  radiusPx: number = 12,
): DesignVertex | null {
  const radiusM = radiusPx / (pxPerM * zoom);
  let bestCandidate: DesignVertex | null = null;
  let bestDistM = radiusM;

  for (const line of lines) {
    // Check 'from' endpoint (PlanPoint: x = north, y = east)
    const fromVertex: DesignVertex = { northM: line.from.x, eastM: line.from.y };
    const distFrom = Math.hypot(pointer.northM - fromVertex.northM, pointer.eastM - fromVertex.eastM);
    if (distFrom < bestDistM) {
      bestDistM = distFrom;
      bestCandidate = fromVertex;
    }

    // Check 'to' endpoint
    const toVertex: DesignVertex = { northM: line.to.x, eastM: line.to.y };
    const distTo = Math.hypot(pointer.northM - toVertex.northM, pointer.eastM - toVertex.eastM);
    if (distTo < bestDistM) {
      bestDistM = distTo;
      bestCandidate = toVertex;
    }
  }

  return bestCandidate;
}
