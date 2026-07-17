import * as missionApi from "../api/missionApi";
import * as pathApi from "../api/pathApi";
import type { PlanLine } from "../types/plan";

export function coerceFiniteNumber(value: unknown): number | null {
  const next = typeof value === "number" ? value : Number(value);
  return Number.isFinite(next) ? next : null;
}

export function formatFinite(value: unknown, digits = 2, fallback = "n/a") {
  const next = coerceFiniteNumber(value);
  return next == null ? fallback : next.toFixed(digits);
}

const PRIMARY_ENTITY_TYPES = new Set(["line", "arc", "circle"]);

export function normalizeEntityType(entityType: unknown) {
  return String(entityType ?? "").trim().toLowerCase();
}

export type NormalizedExtensionRole = "PRE" | "AFT" | "none";

export type NormalizedPathSegment = {
  index: number;
  sequence: number;
  type: "MARK" | "TRANSIT" | string;
  extensionRole: NormalizedExtensionRole;
  sprayOn: boolean;
  sourceEntity: string;
  lengthM: number | null;
};

export function normalizeSegmentType(rawType: unknown): "MARK" | "TRANSIT" | string {
  const type = String(rawType ?? "").trim().toUpperCase();
  if (type === "MARK") return "MARK";
  if (type === "TRANSIT") return "TRANSIT";
  return type || "UNKNOWN";
}

export function normalizeExtensionRole(segment: pathApi.PathSegmentInfo): NormalizedExtensionRole {
  const roleSources = [segment.segment_role, segment.extension_role];
  for (const raw of roleSources) {
    const role = String(raw ?? "").trim().toLowerCase();
    if (role === "pre" || role === "pre_transit") return "PRE";
    if (role === "aft" || role === "aft_transit") return "AFT";
  }
  return "none";
}

export function normalizePathSegment(segment: pathApi.PathSegmentInfo): NormalizedPathSegment {
  return {
    index: segment.index,
    sequence: segment.sequence,
    type: normalizeSegmentType(segment.type),
    extensionRole: normalizeExtensionRole(segment),
    sprayOn: !!segment.spray_on,
    sourceEntity: String(segment.source_entity ?? "").trim(),
    lengthM: coerceFiniteNumber(segment.length_m),
  };
}

export function summarizeNormalizedSegments(segments: pathApi.PathSegmentInfo[]) {
  const normalized = segments.map(normalizePathSegment);
  let markCount = 0;
  let transitCount = 0;
  let preExtensionCount = 0;
  let aftExtensionCount = 0;
  let sprayOnCount = 0;
  let sprayOffCount = 0;

  for (const segment of normalized) {
    if (segment.type === "MARK") markCount += 1;
    if (segment.type === "TRANSIT") transitCount += 1;
    if (segment.extensionRole === "PRE") preExtensionCount += 1;
    if (segment.extensionRole === "AFT") aftExtensionCount += 1;
    if (segment.sprayOn) sprayOnCount += 1;
    else sprayOffCount += 1;
  }

  return {
    normalized,
    markCount,
    transitCount,
    preExtensionCount,
    aftExtensionCount,
    sprayOnCount,
    sprayOffCount,
  };
}

export function parsePathSegmentsResponse(data: unknown): pathApi.PathSegmentsResponse | null {
  if (!data || typeof data !== "object") return null;
  const body = data as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(body, "segments")) return null;
  if (!Array.isArray(body.segments)) return null;
  if (body.segments.length === 0) return null;
  return body as pathApi.PathSegmentsResponse;
}

export function formatExtensionRoleLabel(role: NormalizedExtensionRole) {
  if (role === "PRE") return "pre";
  if (role === "AFT") return "aft";
  return "none";
}

export function formatWaypointPair(waypoints: unknown): string {
  if (!Array.isArray(waypoints) || waypoints.length === 0) return "n/a";
  const formatPoint = (point: unknown) => {
    if (!Array.isArray(point) || point.length < 2) return "n/a";
    return `[${formatFinite(point[0], 2)}, ${formatFinite(point[1], 2)}]`;
  };
  return `${formatPoint(waypoints[0])} → ${formatPoint(waypoints[waypoints.length - 1])}`;
}

export function parsePlanAndStageResponse(data: unknown): { plan: pathApi.PathPlanResponse; missionId: string } | null {
  if (!data || typeof data !== "object") return null;
  const plan = data as pathApi.PathPlanResponse;
  const missionId = plan.mission_summary?.mission_id ?? plan.mission_id;
  if (typeof missionId !== "string" || missionId.trim() === "") return null;
  return { plan, missionId: missionId.trim() };
}

export function formatSprayFlagSample(loaded: missionApi.LoadedPathResponse): string {
  if (!loaded.has_spray_flags) return "n/a";
  return `mark ${loaded.num_mark} / transit ${loaded.num_transit}`;
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
  if (entityLength != null) return entityLength;
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
 * Unified Path Order list row — paths, each transit leg, and one Extension row per
 * Pre/Aft distance group share a single list (no separate sections).
 */
export type PathOrderRow =
  | { kind: "primary"; id: string; line: PlanLine }
  | { kind: "transit"; id: string; line: PlanLine; index: number }
  | { kind: "extension"; id: string; group: ExtensionListGroup; title: string };

/**
 * Build the flat Path Order list:
 *   [all primary paths in drag order] + [each transit leg] + [extension group(s)].
 *
 * Transit and extension are never interleaved into the reorderable primary block —
 * drag only reorders primaries; this helper always re-appends transit/extension after.
 */
export function buildPathOrderRows(
  primaryLines: PlanLine[],
  transitLines: PlanLine[],
  extensionGroups: ExtensionListGroup[]
): PathOrderRow[] {
  const rows: PathOrderRow[] = [];
  for (const line of primaryLines) {
    rows.push({ kind: "primary", id: `primary:${line.id}`, line });
  }
  transitLines.forEach((line, index) => {
    rows.push({ kind: "transit", id: `transit:${line.id}`, line, index });
  });
  const multi = extensionGroups.length > 1;
  extensionGroups.forEach((group, i) => {
    rows.push({
      kind: "extension",
      id: `extension:${group.key}`,
      group,
      title: multi ? `Extension ${i + 1}` : "Extension",
    });
  });
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