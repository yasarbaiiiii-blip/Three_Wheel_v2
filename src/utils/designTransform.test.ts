import { describe, it, expect } from 'vitest';
import {
  flattenDesignDocument,
  screenToDesignMeters,
  designToSvg,
  planLineLength,
  ViewportContext,
  simplifyPath,
} from './designTransform';
import {
  createDesignDocument,
  createDesignInstance,
  createDesignEntity,
  createDesignVertex,
} from '../types/designDocument';
import { TemplateRegistry, createTemplateDefinition } from './designTemplateRegistry';
import type { PlanLine } from '../types/plan';

describe('designTransform', () => {
  it('correctly calculates planLineLength', () => {
    const line: PlanLine = {
      id: 'test',
      label: 'L',
      layer: 'marking',
      from: { id: 0, x: 0, y: 0 },
      to: { id: 1, x: 3, y: 4 },
      width: 0.1,
    };
    expect(planLineLength(line)).toBe(5);
  });

  it('transforms design vertices to SVG pixels correctly', () => {
    const vertex = createDesignVertex(10, 20); // north=10, east=20
    const frame = { originNorthM: 0, originEastM: 0 };
    const svg = designToSvg(vertex, 100, frame);
    // east -> X, north -> -Y
    expect(svg.svgX).toBe(2000);
    expect(svg.svgY).toBe(-1000);
  });

  it('converts screen coordinates back to design meters', () => {
    const ctx: ViewportContext = {
      svgSize: { width: 1000, height: 1000 },
      camera: { x: 0, y: 0, zoom: 1 },
      boundaryWidthM: 10,
      boundaryHeightM: 10,
      frame: { originNorthM: 0, originEastM: 0 },
      pxPerM: 100,
    };

    // Center screen should map to (0, 0) in design meters
    const center = screenToDesignMeters(500, 500, ctx);
    expect(center.northM).toBeCloseTo(0, 5);
    expect(center.eastM).toBeCloseTo(0, 5);

    // X on screen moves right -> East increases
    // Y on screen moves down -> North decreases
    const offset = screenToDesignMeters(600, 600, ctx);
    expect(offset.eastM).toBeGreaterThan(0);
    expect(offset.northM).toBeLessThan(0);
  });

  it('flattens clean instances and entities correctly', () => {
    const registry = new TemplateRegistry();
    const templateLines: PlanLine[] = [
      {
        id: 'tpl-1',
        label: 'T1',
        layer: 'marking',
        from: { id: 0, x: 0, y: 0 },
        to: { id: 1, x: 2, y: 0 }, // length 2 along north (x)
        width: 0.1,
      },
    ];
    const def = createTemplateDefinition('rect', templateLines, 2, 1);
    registry.registerTemplate(def);

    const doc = createDesignDocument();
    
    // Add instance: translated northM=5, scale=2, rotation=90
    const instance = createDesignInstance('inst-1', 'rect', {
      northM: 5,
      eastM: 10,
      rotationDeg: 90,
      scale: 2,
    });
    doc.nodes.push(instance);

    // Add entity: polyline with 3 vertices
    const entity = createDesignEntity(
      'ent-1',
      'POLYLINE',
      'marking',
      [
        createDesignVertex(0, 0),
        createDesignVertex(1, 1),
        createDesignVertex(2, 2),
      ]
    );
    doc.nodes.push(entity);

    const flatLines = flattenDesignDocument(doc, registry);
    // Instance yields 1 line, Entity yields 2 lines (3 vertices = 2 segments)
    expect(flatLines).toHaveLength(3);

    // Verify instance line transformation
    // Original template: (0,0) -> (2,0)
    // Rotated 90 deg: Math.cos(90)=0, Math.sin(90)=1
    // worldNorth = (localNorth * 0 - localEast * 1) * 2 + 5 = 5
    // worldEast  = (localNorth * 1 + localEast * 0) * 2 + 10
    // from: worldNorth = 5, worldEast = 10
    // to: localNorth = 2 -> worldNorth = 5, worldEast = 2 * 2 + 10 = 14
    const instLine = flatLines.find(l => l.id.startsWith('inst-1'));
    expect(instLine).toBeDefined();
    expect(instLine!.from.x).toBeCloseTo(5, 5); // x=north
    expect(instLine!.from.y).toBeCloseTo(10, 5); // y=east
    expect(instLine!.to.x).toBeCloseTo(5, 5);
    expect(instLine!.to.y).toBeCloseTo(14, 5);
  });

  it('simplifies polylines using simplifyPath RDP helper correctly', () => {
    const straightLine = [
      createDesignVertex(0, 0),
      createDesignVertex(1, 1.001), // very close to the straight line y = x
      createDesignVertex(2, 2),
    ];
    
    // Tolerance 0.005 should remove the middle point
    const simplified = simplifyPath(straightLine, 0.005);
    expect(simplified).toHaveLength(2);
    expect(simplified[0]).toEqual(straightLine[0]);
    expect(simplified[1]).toEqual(straightLine[2]);

    const complexLine = [
      createDesignVertex(0, 0),
      createDesignVertex(1, 10), // huge spike
      createDesignVertex(2, 0),
    ];
    // Spiked point should be kept
    const simplifiedComplex = simplifyPath(complexLine, 0.005);
    expect(simplifiedComplex).toHaveLength(3);
  });
});
