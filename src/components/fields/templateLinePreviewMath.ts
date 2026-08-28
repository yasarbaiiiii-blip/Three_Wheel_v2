import type { PlanLine } from "../../types/plan";

type Seg = { x1: number; y1: number; x2: number; y2: number };

export const PREVIEW_ZOOM_MIN = 0.7;
export const PREVIEW_ZOOM_MAX = 4;

export function clampPreviewZoom(z: number) {
  if (!Number.isFinite(z)) return 1;
  return Math.min(PREVIEW_ZOOM_MAX, Math.max(PREVIEW_ZOOM_MIN, z));
}

/** Convert a pixel stroke to SVG user units for the current viewBox. */
export function previewStrokeUser(viewBoxSpan: number, pixelSize: number, strokePx: number) {
  if (!(viewBoxSpan > 0) || !(pixelSize > 0)) return 0.02;
  return (Math.max(0.9, strokePx) * viewBoxSpan) / pixelSize;
}

export function collectPreviewSegs(lines: PlanLine[], horizontal = true) {
  const raw: Seg[] = [];
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const line of lines) {
    const x1 = line.from.y;
    const y1 = -line.from.x;
    const x2 = line.to.y;
    const y2 = -line.to.x;
    raw.push({ x1, y1, x2, y2 });
    minX = Math.min(minX, x1, x2);
    maxX = Math.max(maxX, x1, x2);
    minY = Math.min(minY, y1, y2);
    maxY = Math.max(maxY, y1, y2);
  }
  if (!Number.isFinite(minX)) {
    return {
      segs: [] as Seg[],
      minX: -1,
      maxX: 1,
      minY: -1,
      maxY: 1,
      contentMinX: -1,
      contentMaxX: 1,
      contentMinY: -1,
      contentMaxY: 1,
    };
  }

  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const tall = maxY - minY > maxX - minX + 1e-6;
  const segs =
    horizontal && tall
      ? raw.map((s) => {
          const r = (x: number, y: number) => {
            const dx = x - cx;
            const dy = y - cy;
            return { x: cx + dy, y: cy - dx };
          };
          const a = r(s.x1, s.y1);
          const b = r(s.x2, s.y2);
          return { x1: a.x, y1: a.y, x2: b.x, y2: b.y };
        })
      : raw;

  let nMinX = Infinity;
  let nMaxX = -Infinity;
  let nMinY = Infinity;
  let nMaxY = -Infinity;
  for (const s of segs) {
    nMinX = Math.min(nMinX, s.x1, s.x2);
    nMaxX = Math.max(nMaxX, s.x1, s.x2);
    nMinY = Math.min(nMinY, s.y1, s.y2);
    nMaxY = Math.max(nMaxY, s.y1, s.y2);
  }
  const span = Math.max(nMaxX - nMinX, nMaxY - nMinY, 0.2);
  const pad = span * 0.12;
  const midX = (nMinX + nMaxX) / 2;
  const midY = (nMinY + nMaxY) / 2;
  const half = span / 2 + pad;
  return {
    segs,
    minX: midX - half,
    maxX: midX + half,
    minY: midY - half,
    maxY: midY + half,
    contentMinX: nMinX,
    contentMaxX: nMaxX,
    contentMinY: nMinY,
    contentMaxY: nMaxY,
  };
}

export type DimTier = "large" | "medium" | "tiny";

export type DimMark = {
  x: number;
  y: number;
  text: string;
  lengthM: number;
  tier: DimTier;
};

export function worldToPreviewPx(
  x: number,
  y: number,
  frame: { minX: number; maxX: number; minY: number; maxY: number },
  size: number
) {
  const span = Math.max(frame.maxX - frame.minX, 0.2);
  return {
    left: ((x - frame.minX) / span) * size,
    top: ((y - frame.minY) / span) * size,
  };
}

export function collectDimensionLods(lines: PlanLine[], horizontal = false): DimMark[] {
  const frame = collectPreviewSegs(lines, horizontal);
  const cMinX = frame.contentMinX;
  const cMaxX = frame.contentMaxX;
  const cMinY = frame.contentMinY;
  const cMaxY = frame.contentMaxY;
  const width = Math.max(0, cMaxX - cMinX);
  const height = Math.max(0, cMaxY - cMinY);
  const span = Math.max(width, height, 0.2);
  const marks: DimMark[] = [
    {
      x: (cMinX + cMaxX) / 2,
      y: cMaxY + span * 0.07,
      text: `${width.toFixed(2)} m`,
      lengthM: width,
      tier: "large",
    },
    {
      x: cMinX - span * 0.07,
      y: (cMinY + cMaxY) / 2,
      text: `${height.toFixed(2)} m`,
      lengthM: height,
      tier: "large",
    },
  ];

  const parts = frame.segs
    .map((s) => {
      const len = Math.hypot(s.x2 - s.x1, s.y2 - s.y1);
      return { len, mx: (s.x1 + s.x2) / 2, my: (s.y1 + s.y2) / 2 };
    })
    .filter((p) => p.len > span * 0.035)
    .sort((a, b) => b.len - a.len);

  let medium = 0;
  let tiny = 0;
  const seen: Array<{ len: number; mx: number; my: number }> = [];
  for (const p of parts) {
    const crowded = seen.some(
      (s) => Math.abs(s.len - p.len) < span * 0.02 && Math.hypot(s.mx - p.mx, s.my - p.my) < span * 0.08
    );
    if (crowded) continue;
    const rel = p.len / span;
    if (rel >= 0.38) continue;
    const tier: DimTier = rel >= 0.12 ? "medium" : "tiny";
    if (tier === "medium") {
      if (medium >= 8) continue;
      medium += 1;
    } else {
      if (tiny >= 10) continue;
      tiny += 1;
    }
    seen.push(p);
    marks.push({
      x: p.mx,
      y: p.my,
      text: `${p.len.toFixed(2)} m`,
      lengthM: p.len,
      tier,
    });
  }
  return marks;
}
