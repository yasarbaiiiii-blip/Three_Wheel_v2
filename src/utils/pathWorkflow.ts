import type { PlanLine } from "../types/plan";

export function coerceFiniteNumber(value: unknown): number | null {
  const next = typeof value === "number" ? value : Number(value);
  return Number.isFinite(next) ? next : null;
}

export function formatFinite(value: unknown, digits = 2, fallback = "n/a") {
  const next = coerceFiniteNumber(value);
  return next == null ? fallback : next.toFixed(digits);
}

// LWPOLYLINE/POLYLINE included: a shape drawn as a single (closed) polyline —
// e.g. a georeferenced square — is a primary drivable path, not a stray. Without
// it, such a DXF produced an empty path order and its extensions/connectors never rendered.
const PRIMARY_ENTITY_TYPES = new Set(["line", "arc", "circle", "lwpolyline", "polyline"]);

export function normalizeEntityType(entityType: unknown) {
  return String(entityType ?? "").trim().toLowerCase();
}

/**
 * Best-available physical length for a PlanLine, in metres.
 *
 * Extension lines (`layer==="extension"`) need special handling: they carry a
 * COPY of the parent entity (see App.tsx's fallbackExtLines construction), so
 * `entity.length_m` on them is the parent mark's length, not this run-up/
 * run-out segment's own length. The correct per-role length lives in
 * `entity.extension_preview.pre_length_m` / `aft_length_m`, keyed by the
 * `ext-pre-`/`ext-aft-` id prefix.
 */
export function getLineLengthM(line: PlanLine): number | null {
  if (line.layer === "extension" && line.entity?.extension_preview) {
    if (line.id.startsWith("ext-pre-")) {
      return coerceFiniteNumber(line.entity.extension_preview.pre_length_m);
    }
    if (line.id.startsWith("ext-aft-")) {
      return coerceFiniteNumber(line.entity.extension_preview.aft_length_m);
    }
  }
  const entityLength = coerceFiniteNumber(line.entity?.length_m);
  // Treat 0 as "unset": CSV builders historically hard-coded length_m: 0, and a
  // true zero-length path is not a useful selection label. Prefer measured geometry.
  if (entityLength != null && entityLength > 0) return entityLength;

  const preview = line.entity?.preview_points;
  if (preview && preview.length >= 2) {
    let total = 0;
    for (let i = 1; i < preview.length; i++) {
      total += Math.hypot(
        preview[i].north - preview[i - 1].north,
        preview[i].east - preview[i - 1].east
      );
    }
    if (Number.isFinite(total) && total > 0) return total;
  }

  return coerceFiniteNumber(Math.hypot(line.to.x - line.from.x, line.to.y - line.from.y));
}

/**
 * Optional second argument for plan-line selection.
 *
 * When `highlightLineIds` is a non-empty array, the preview highlights every
 * listed line (used for Path Order "Extension" rows so all pre/aft segments of
 * that distance group light up together). When omitted/null, only `id` is
 * highlighted — the default for canvas taps and for individual entities
 * (line/arc/circle/transit).
 */
export type SelectLineOptions = {
  highlightLineIds?: string[] | null;
};

export type SelectLineFn = (id: string | null, options?: SelectLineOptions) => void;

/** One Path Order list row for a unique (pre, aft) extension-distance group. */
export type ExtensionListGroup = {
  key: string;
  preM: number | null;
  aftM: number | null;
  lineIds: string[];
  lines: PlanLine[];
};

/** Stable key for grouping extension segments that share the same Pre/Aft distances. */
export function getExtensionGroupKey(preM: number | null, aftM: number | null): string {
  const fmt = (v: number | null) => (v == null ? "na" : v.toFixed(4));
  return `${fmt(preM)}|${fmt(aftM)}`;
}

/**
 * Resolve the Pre/Aft distances that should label an extension line in the list.
 * Prefer per-entity `extension_preview` lengths (authoritative for that segment's
 * parent), then fall back to the global Step-1 config values.
 */
export function getExtensionListDistances(
  line: PlanLine,
  fallbackPre?: unknown,
  fallbackAft?: unknown
): { preM: number | null; aftM: number | null } {
  const preview = line.entity?.extension_preview;
  return {
    preM: coerceFiniteNumber(preview?.pre_length_m) ?? coerceFiniteNumber(fallbackPre),
    aftM: coerceFiniteNumber(preview?.aft_length_m) ?? coerceFiniteNumber(fallbackAft),
  };
}

/**
 * Group extension-layer lines for the Path Order list.
 *
 * Same (pre, aft) → one "Extension" row that multi-highlights all members.
 * Different distances (e.g. 0.5 m vs 0.8 m) → separate rows, as required when
 * multiple plans/configs contribute distinct extension lengths.
 */
export function groupExtensionLinesForList(
  lines: PlanLine[],
  fallbackPre?: unknown,
  fallbackAft?: unknown
): ExtensionListGroup[] {
  const groups = new Map<string, ExtensionListGroup>();
  for (const line of lines) {
    if (line.layer !== "extension") continue;
    const { preM, aftM } = getExtensionListDistances(line, fallbackPre, fallbackAft);
    const key = getExtensionGroupKey(preM, aftM);
    const existing = groups.get(key);
    if (existing) {
      existing.lines.push(line);
      existing.lineIds.push(line.id);
    } else {
      groups.set(key, { key, preM, aftM, lines: [line], lineIds: [line.id] });
    }
  }
  return Array.from(groups.values());
}

/** True when the current multi-highlight set is exactly this extension group. */
export function isExtensionGroupSelected(
  group: ExtensionListGroup,
  selectedLineId: string | null,
  highlightLineIds: string[] | null | undefined
): boolean {
  if (highlightLineIds && highlightLineIds.length > 0) {
    if (highlightLineIds.length !== group.lineIds.length) return false;
    const set = new Set(highlightLineIds);
    return group.lineIds.every((id) => set.has(id));
  }
  return selectedLineId != null && group.lineIds.includes(selectedLineId);
}

/**
 * Unified Path Order list row.
 *
 * Layout: paths → extension group(s) → transit dropdown (optional expanded children).
 * Extension run-ups are never listed as transit (they already have their own row).
 */
export type PathOrderRow =
  | { kind: "primary"; id: string; line: PlanLine }
  | { kind: "extension"; id: string; group: ExtensionListGroup; title: string }
  | { kind: "transitDropdown"; id: string; count: number; expanded: boolean }
  | { kind: "transit"; id: string; line: PlanLine; index: number };

/**
 * True for inter-shape transit legs only — not extension run-ups/run-outs.
 * Extension geometry is listed under the Extension entity row(s), never under Transit.
 *
 * Prefers `segmentRole` (set at path-load when /plan non-spray was classified against
 * the /entities extension catalog). Falls back to id / extension_preview guards.
 */
export function isInterShapeTransitLine(line: PlanLine): boolean {
  if (line.layer !== "transit") return false;
  // Authoritative when load-time classification ran.
  if (line.segmentRole === "pre" || line.segmentRole === "aft") return false;
  const id = String(line.id ?? "").toLowerCase();
  // Client-built extension stubs use ext-pre- / ext-aft- ids; never treat as transit.
  if (id.startsWith("ext-pre-") || id.startsWith("ext-aft-") || id.includes("extension")) {
    return false;
  }
  // Defensive: a line that still carries enabled extension_preview is extension geometry.
  if (line.entity?.extension_preview?.enabled) return false;
  return true;
}

/** Inter-shape transit legs for the Path Order transit dropdown (excludes extension stubs). */
export function getInterShapeTransitLines(lines: PlanLine[]): PlanLine[] {
  return lines.filter(isInterShapeTransitLine);
}

/**
 * Build the Path Order list:
 *   [primary paths] → [extension group(s)] → [Transit dropdown] → [transit children if open]
 *
 * Drag only reorders primaries; extension/transit always trail that block.
 */
export function buildPathOrderRows(
  primaryLines: PlanLine[],
  transitLines: PlanLine[],
  extensionGroups: ExtensionListGroup[],
  options?: { transitExpanded?: boolean }
): PathOrderRow[] {
  const transitExpanded = options?.transitExpanded === true;
  // Always re-filter so callers can pass raw lines without double-listing extensions.
  const safeTransit = transitLines.filter(isInterShapeTransitLine);

  const rows: PathOrderRow[] = [];
  for (const line of primaryLines) {
    rows.push({ kind: "primary", id: `primary:${line.id}`, line });
  }

  const multi = extensionGroups.length > 1;
  extensionGroups.forEach((group, i) => {
    rows.push({
      kind: "extension",
      id: `extension:${group.key}`,
      group,
      title: multi ? `Extension ${i + 1}` : "Extension",
    });
  });

  if (safeTransit.length > 0) {
    rows.push({
      kind: "transitDropdown",
      id: "transit-dropdown",
      count: safeTransit.length,
      expanded: transitExpanded,
    });
    if (transitExpanded) {
      safeTransit.forEach((line, index) => {
        rows.push({ kind: "transit", id: `transit:${line.id}`, line, index });
      });
    }
  }

  return rows;
}

/** After a mixed-list drag, recover primary order and ignore transit/extension positions. */
export function extractPrimaryLinesFromPathOrderRows(rows: PathOrderRow[]): PlanLine[] {
  return rows.filter((row): row is Extract<PathOrderRow, { kind: "primary" }> => row.kind === "primary").map((row) => row.line);
}

export function isPrimaryEditableLine(line: PlanLine) {
  if (line.layer === "transit" || line.layer === "extension") {
    return false;
  }
  return PRIMARY_ENTITY_TYPES.has(normalizeEntityType(line.entity?.entity_type));
}

function isRenderableLine(line: PlanLine | null | undefined): line is PlanLine {
  return Boolean(
    line &&
    line.from &&
    line.to &&
    coerceFiniteNumber(line.from.x) != null &&
    coerceFiniteNumber(line.from.y) != null &&
    coerceFiniteNumber(line.to.x) != null &&
    coerceFiniteNumber(line.to.y) != null
  );
}

export function sanitizePlanLines(lines: PlanLine[]) {
  return lines.filter(isRenderableLine);
}