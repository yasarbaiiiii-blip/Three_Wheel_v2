import type { PlanLine } from "../types/plan";

export type ShapeType = "square" | "circle" | "triangle";
export type ArcType = "quarter" | "half" | "full";

export function generateTemplateLines(shape: ShapeType, size: number, arcType: ArcType = "full"): PlanLine[] {
  const lines: PlanLine[] = [];
  
  if (shape === "square") {
    const half = size / 2;
    // Square coordinates (n, e)
    const pts = [
      [-half, -half],
      [half, -half],
      [half, half],
      [-half, half],
      [-half, -half],
    ];
    for (let i = 0; i < 4; i++) {
        lines.push({
            id: `shape-line-${i}`, label: `Square Side ${i + 1}`, layer: "marking", width: 0.1,
            from: { id: i * 2, x: pts[i][0], y: pts[i][1] },
            to: { id: i * 2 + 1, x: pts[i + 1][0], y: pts[i + 1][1] },
        });
    }
  } else if (shape === "triangle") {
        // Equilateral-ish triangle
        const half = size / 2;
        const height = size * (Math.sqrt(3) / 2);
        // Center the triangle vertically
        const yOffset = height / 3; 
        
        const pts = [
            [0, height - yOffset],          // Top
            [-half, -yOffset],              // Bottom left
            [half, -yOffset],               // Bottom right
            [0, height - yOffset]           // Back to top
        ];

        for (let i = 0; i < 3; i++) {
            lines.push({
                id: `shape-line-${i}`, label: `Triangle Side ${i + 1}`, layer: "marking", width: 0.1,
                from: { id: i * 2, x: pts[i][0], y: pts[i][1] },
                to: { id: i * 2 + 1, x: pts[i + 1][0], y: pts[i + 1][1] },
            });
        }
  } else if (shape === "circle") {
    const radius = size / 2;
    const startAngle = arcType === "quarter" ? 0 : 0;
    const endAngle = arcType === "full" ? 360 : arcType === "half" ? 180 : 90;
    const sweep = endAngle - startAngle;
    const segments = arcType === "full" ? 144 : arcType === "half" ? 72 : 36;
    const previewPoints: { north: number; east: number }[] = [];

    for (let i = 0; i <= segments; i++) {
      const angleDeg = startAngle + (sweep * i) / segments;
      const radians = (angleDeg * Math.PI) / 180;
      previewPoints.push({
        north: radius * Math.sin(radians),
        east: radius * Math.cos(radians),
      });
    }

    const entityType = arcType === "full" ? "CIRCLE" : "ARC";
    lines.push({
      id: "template-circle-0",
      label: arcType === "full" ? "Circle" : `Arc (${arcType})`,
      layer: "marking",
      from: { id: 1, x: previewPoints[0].north, y: previewPoints[0].east },
      to: {
        id: 2,
        x: previewPoints[previewPoints.length - 1].north,
        y: previewPoints[previewPoints.length - 1].east,
      },
      width: 0.1,
      entity: {
        entity_id: "template-circle",
        entity_type: entityType,
        layer: "0",
        color: 7,
        is_mark: false,
        length_m: (sweep / 360) * 2 * Math.PI * radius,
        geometry: {
          centerNorth: 0,
          centerEast: 0,
          radius,
          startAngle,
          endAngle,
        },
        preview_points: previewPoints,
      },
    });
  }

  return lines;
}
