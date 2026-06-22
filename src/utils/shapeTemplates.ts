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
    // Circle generated using polygon segments. Size = diameter
    const radius = size / 2;
    let angleMult = 2; // full circle is 2*PI
    if (arcType === "half") angleMult = 1;
    if (arcType === "quarter") angleMult = 0.5;

    let segments = 36;
    if (arcType === "half") segments = 18;
    if (arcType === "quarter") segments = 9;

    const pts = [];
    for (let i = 0; i <= segments; i++) {
      const angle = (i / segments) * angleMult * Math.PI;
      pts.push({
        n: radius * Math.cos(angle),
        e: radius * Math.sin(angle),
      });
    }
    for (let i = 0; i < segments; i++) {
      lines.push({
        id: `template-circle-${i}`,
        label: `Segment ${i + 1}`,
        layer: "marking",
        from: { id: i * 2 + 1, x: pts[i].n, y: pts[i].e },
        to: { id: i * 2 + 2, x: pts[i+1].n, y: pts[i+1].e },
        width: 0.1,
      });
    }
  }

  return lines;
}
