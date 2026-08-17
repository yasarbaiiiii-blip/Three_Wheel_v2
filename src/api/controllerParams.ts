export type ParamFamily = "rpp" | "spray";
export type ParamValue = string | number | boolean;

export type ControllerParam = {
  name: string;
  type: string;
  default: ParamValue | null;
  current: ParamValue | null;
  group: string;
  description: string;
  min: number | null;
  max: number | null;
};

export type ControllerParamListResponse = {
  parameters?: ControllerParam[];
  count?: number;
};

const MAX_DIAL_TICKS = 201;

export const RPP_FIELD_ORDER = [
  "mission_speed",
  "tracking_profile",
  "require_rtk_fix",
  "max_linear_vel",
  "min_linear_vel",
  "max_linear_accel",
  "max_linear_decel",
  "xy_goal_tolerance",
  "segment_slowdown_dist",
  "segment_min_corner_speed",
] as const;

export const SPRAY_FIELD_ORDER = [
  "solenoid_open_delay_s",
  "solenoid_close_delay_s",
  "on_overspray_margin_m",
  "off_overspray_margin_m",
  "nozzle_forward_offset_m",
  "nozzle_lateral_offset_m",
  "max_xtrack_error_m",
  "use_distance_aware_spray",
  "debounce_samples",
] as const;

export const INERT_PARAM_NAMES = new Set(["min_spray_speed_mps"]);

export const ENUM_OPTIONS: Record<string, { value: string; label: string }[]> = {
  tracking_profile: [
    { value: "auto", label: "Auto" },
    { value: "segment", label: "Segment" },
    { value: "smooth", label: "Smooth" },
  ],
  actuator_backend: [
    { value: "mavlink_actuator", label: "Actuator" },
    { value: "mavlink_servo_pwm", label: "Servo PWM" },
  ],
};

const FIELD_LABELS: Record<string, string> = {
  mission_speed: "Mission speed",
  tracking_profile: "Tracking profile",
  require_rtk_fix: "Require RTK fix",
  max_linear_vel: "Max speed",
  min_linear_vel: "Min speed",
  max_linear_accel: "Acceleration",
  max_linear_decel: "Deceleration",
  xy_goal_tolerance: "Goal tolerance",
  segment_slowdown_dist: "Corner slowdown",
  segment_min_corner_speed: "Corner min speed",
  solenoid_open_delay_s: "Solenoid open delay",
  solenoid_close_delay_s: "Solenoid close delay",
  on_overspray_margin_m: "ON overspray",
  off_overspray_margin_m: "OFF overspray",
  nozzle_forward_offset_m: "Nozzle forward",
  nozzle_lateral_offset_m: "Nozzle lateral",
  max_xtrack_error_m: "Max spray xtrack",
  use_distance_aware_spray: "Distance-aware spray",
  debounce_samples: "Debounce samples",
};

const UNIT_BY_NAME: Record<string, string> = {
  mission_speed: "m/s",
  max_linear_vel: "m/s",
  min_linear_vel: "m/s",
  max_linear_accel: "m/s²",
  max_linear_decel: "m/s²",
  a_lat_max: "m/s²",
  yaw_rate_feedback_gain: "1/s",
  max_yaw_rate_body: "rad/s",
  segment_yaw_rate_gain: "rad/s",
  segment_stop_yaw_rate_threshold: "rad/s",
};

export function familyPath(family: ParamFamily): string {
  return family === "rpp" ? "/api/rpp/params" : "/api/spray/params";
}

function apiUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/$/, "")}${path}`;
}

export async function readApiError(res: Response): Promise<string> {
  const text = await res.text();
  try {
    const body = JSON.parse(text) as { detail?: unknown };
    if (typeof body.detail === "string") return body.detail;
    if (Array.isArray(body.detail)) {
      return body.detail
        .map((item) => (typeof item === "string" ? item : (item as { msg?: string })?.msg))
        .filter(Boolean)
        .join("; ");
    }
  } catch {
    // raw text
  }
  return text.trim() || `HTTP ${res.status}`;
}

export function normalizeControllerParams(raw: unknown): ControllerParam[] {
  const payload = raw as ControllerParamListResponse | ControllerParam[] | null;
  const list = Array.isArray(payload) ? payload : payload?.parameters;
  if (!Array.isArray(list)) return [];
  return list
    .filter((item): item is ControllerParam => Boolean(item && typeof item.name === "string"))
    .map((item) => ({
      name: item.name,
      type: String(item.type ?? "string").toLowerCase(),
      default: (item.default ?? null) as ParamValue | null,
      current: (item.current ?? null) as ParamValue | null,
      group: item.group || "Other",
      description: item.description || "",
      min: typeof item.min === "number" ? item.min : null,
      max: typeof item.max === "number" ? item.max : null,
    }));
}

export const PARAMS_REQUEST_TIMEOUT_MS = 20000;

export type SetParamsResult = {
  ok: boolean;
  accepted: string[];
  rejected: string[];
};

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = PARAMS_REQUEST_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("Rover did not respond in time. Check Wi-Fi and try again.");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchControllerParams(
  baseUrl: string,
  family: ParamFamily,
  timeoutMs = PARAMS_REQUEST_TIMEOUT_MS
): Promise<ControllerParam[]> {
  const res = await fetchWithTimeout(
    apiUrl(baseUrl, familyPath(family)),
    { method: "GET", headers: { Accept: "application/json" } },
    timeoutMs
  );
  if (!res.ok) throw new Error(await readApiError(res));
  return normalizeControllerParams(await res.json());
}

export function interpretSetParamsResult(
  payload: Record<string, ParamValue>,
  body: unknown
): SetParamsResult {
  const names = Object.keys(payload);
  if (!body || typeof body !== "object") {
    return { ok: true, accepted: names, rejected: [] };
  }
  const record = body as { ok?: unknown; parameters?: unknown };
  const map =
    record.parameters && typeof record.parameters === "object" && !Array.isArray(record.parameters)
      ? (record.parameters as Record<string, unknown>)
      : null;

  if (map) {
    const accepted: string[] = [];
    const rejected: string[] = [];
    for (const name of names) {
      if (map[name] === false) rejected.push(name);
      else accepted.push(name);
    }
    return { ok: record.ok !== false && rejected.length === 0, accepted, rejected };
  }

  if (record.ok === false) {
    return { ok: false, accepted: [], rejected: names };
  }
  return { ok: true, accepted: names, rejected: [] };
}

export function mergeAppliedCurrent(
  params: ControllerParam[],
  applied: Record<string, ParamValue>
): ControllerParam[] {
  if (Object.keys(applied).length === 0) return params;
  return params.map((item) =>
    item.name in applied ? { ...item, current: applied[item.name] } : item
  );
}

export function dropSettledEdits(
  edits: Record<string, ParamValue>,
  payload: Record<string, ParamValue>,
  accepted: string[],
  paramsByName: Map<string, ControllerParam>
): Record<string, ParamValue> {
  if (accepted.length === 0) return edits;
  const acceptedSet = new Set(accepted);
  let changed = false;
  const next: Record<string, ParamValue> = {};
  for (const [name, value] of Object.entries(edits)) {
    if (!acceptedSet.has(name)) {
      next[name] = value;
      continue;
    }
    const param = paramsByName.get(name);
    if (param && !valuesEqual(value, payload[name], param.type)) {
      next[name] = value;
      continue;
    }
    changed = true;
  }
  return changed || Object.keys(next).length !== Object.keys(edits).length ? next : edits;
}

export function formatAppliedNames(names: string[]): string {
  const labels = names.map(paramLabel);
  if (labels.length === 0) return "";
  if (labels.length <= 3) return labels.join(", ");
  return `${labels.slice(0, 2).join(", ")} +${labels.length - 2} more`;
}

export async function setControllerParams(
  baseUrl: string,
  family: ParamFamily,
  parameters: Record<string, ParamValue>,
  timeoutMs = PARAMS_REQUEST_TIMEOUT_MS
): Promise<SetParamsResult> {
  const res = await fetchWithTimeout(
    apiUrl(baseUrl, familyPath(family)),
    {
      method: "PUT",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ parameters }),
    },
    timeoutMs
  );
  if (!res.ok) throw new Error(await readApiError(res));
  const text = await res.text();
  if (!text.trim()) return interpretSetParamsResult(parameters, null);
  try {
    return interpretSetParamsResult(parameters, JSON.parse(text));
  } catch {
    return interpretSetParamsResult(parameters, null);
  }
}

export function paramKind(param: Pick<ControllerParam, "type">): string {
  return String(param.type ?? "").trim().toLowerCase();
}

export function isBoolParam(param: Pick<ControllerParam, "type">): boolean {
  return ["bool", "boolean"].includes(paramKind(param));
}

export function isIntParam(param: Pick<ControllerParam, "type">): boolean {
  return ["int", "integer"].includes(paramKind(param));
}

export function isFloatParam(param: Pick<ControllerParam, "type">): boolean {
  return ["float", "double", "number"].includes(paramKind(param));
}

export function isNumericParam(param: Pick<ControllerParam, "type">): boolean {
  return isIntParam(param) || isFloatParam(param);
}

export function baselineValue(param: ControllerParam): ParamValue | null {
  return param.current ?? param.default ?? null;
}

export function formatParamValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number" && Number.isFinite(value)) {
    if (Number.isInteger(value)) return String(value);
    return String(Number(value.toPrecision(8)));
  }
  return String(value);
}

export function paramLabel(name: string): string {
  if (FIELD_LABELS[name]) return FIELD_LABELS[name];
  return name.replace(/_/g, " ");
}

export function paramUnit(name: string): string | null {
  if (UNIT_BY_NAME[name]) return UNIT_BY_NAME[name];
  if (name.endsWith("_m_s2")) return "m/s²";
  if (name.endsWith("_m_s") || name.endsWith("_mps")) return "m/s";
  if (name.endsWith("_deg")) return "deg";
  if (name.endsWith("_hz")) return "Hz";
  if (name.endsWith("_us")) return "µs";
  if (name.endsWith("_s")) return "s";
  if (name.endsWith("_m")) return "m";
  return null;
}

export function decimalsForStep(step: number): number {
  if (step >= 1) return 0;
  const raw = Math.ceil(-Math.log10(step));
  return Math.max(0, Math.min(4, raw));
}

export function roundToStep(value: number, step: number): number {
  if (!(step > 0)) return value;
  const rounded = Math.round(value / step) * step;
  return Number(rounded.toFixed(decimalsForStep(step)));
}

export function dialStepFor(param: ControllerParam, min: number, max: number): number {
  const range = Math.max(0, max - min);
  if (isIntParam(param)) {
    if (range <= 200) return 1;
    return Math.max(1, Math.ceil(range / 200));
  }
  if (range <= 1) return 0.01;
  if (range <= 2) return 0.02;
  if (range <= 5) return 0.05;
  if (range <= 10) return 0.1;
  if (range <= 50) return 0.5;
  if (range <= 200) return 1;
  return Number((range / 200).toPrecision(1));
}

export function numericBounds(param: ControllerParam, value: number | null): { min: number; max: number } {
  if (typeof param.min === "number" && typeof param.max === "number") {
    return param.min <= param.max
      ? { min: param.min, max: param.max }
      : { min: param.max, max: param.min };
  }
  const center = Number.isFinite(value ?? NaN) ? (value as number) : 0;
  if (typeof param.min === "number") {
    const span = Math.max(1, Math.abs(center - param.min) * 2, Math.abs(param.min) || 1);
    return { min: param.min, max: param.min + span };
  }
  if (typeof param.max === "number") {
    const span = Math.max(1, Math.abs(param.max - center) * 2, Math.abs(param.max) || 1);
    return { min: param.max - span, max: param.max };
  }
  if (isIntParam(param)) {
    return { min: Math.min(0, Math.floor(center) - 10), max: Math.max(10, Math.ceil(center) + 10) };
  }
  const pad = Math.max(1, Math.abs(center) || 1);
  return { min: center - pad, max: center + pad };
}

export function buildDialTicks(param: ControllerParam, value: number | null): number[] {
  const { min, max } = numericBounds(param, value);
  const step = dialStepFor(param, min, max);
  const ticks: number[] = [];
  const lastIndex = Math.min(MAX_DIAL_TICKS - 2, Math.max(1, Math.round((max - min) / step)));
  for (let i = 0; i <= lastIndex; i += 1) {
    ticks.push(roundToStep(min + i * step, step));
  }
  const end = roundToStep(max, step);
  if (ticks[ticks.length - 1] !== end) ticks.push(end);
  const unique = Array.from(new Set(ticks)).sort((a, b) => a - b);
  if (value != null && Number.isFinite(value) && !unique.some((tick) => Math.abs(tick - value) < 1e-9)) {
    unique.push(isIntParam(param) ? Math.round(value) : value);
    unique.sort((a, b) => a - b);
  }
  return unique.slice(0, MAX_DIAL_TICKS);
}

export function nearestTickIndex(ticks: number[], value: number): number {
  if (ticks.length === 0) return 0;
  let best = 0;
  let bestDist = Math.abs(ticks[0] - value);
  for (let i = 1; i < ticks.length; i += 1) {
    const dist = Math.abs(ticks[i] - value);
    if (dist < bestDist) {
      best = i;
      bestDist = dist;
    }
  }
  return best;
}

export function coerceParamValue(raw: string, param: ControllerParam): ParamValue {
  const value = raw.trim();
  if (isBoolParam(param)) {
    const normalized = value.toLowerCase();
    if (["true", "1", "yes", "on"].includes(normalized)) return true;
    if (["false", "0", "no", "off"].includes(normalized)) return false;
    throw new Error(`${paramLabel(param.name)} must be true or false.`);
  }
  if (isIntParam(param)) {
    if (!/^-?\d+$/.test(value)) throw new Error(`${paramLabel(param.name)} must be an integer.`);
    const parsed = Number.parseInt(value, 10);
    validateParamRange(parsed, param);
    return parsed;
  }
  if (isFloatParam(param)) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) throw new Error(`${paramLabel(param.name)} must be a number.`);
    validateParamRange(parsed, param);
    return parsed;
  }
  return value;
}

export function coerceTypedValue(value: ParamValue, param: ControllerParam): ParamValue {
  if (isBoolParam(param)) return Boolean(value);
  if (isIntParam(param)) {
    const parsed = typeof value === "number" ? Math.round(value) : Number.parseInt(String(value), 10);
    if (!Number.isFinite(parsed)) throw new Error(`${paramLabel(param.name)} must be an integer.`);
    validateParamRange(parsed, param);
    return parsed;
  }
  if (isFloatParam(param)) {
    const parsed = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(parsed)) throw new Error(`${paramLabel(param.name)} must be a number.`);
    validateParamRange(parsed, param);
    return parsed;
  }
  return String(value);
}

export function validateParamRange(value: number, param: ControllerParam) {
  if (typeof param.min === "number" && value < param.min) {
    throw new Error(`${paramLabel(param.name)} must be at least ${param.min}.`);
  }
  if (typeof param.max === "number" && value > param.max) {
    throw new Error(`${paramLabel(param.name)} must be at most ${param.max}.`);
  }
}

export function valuesEqual(a: unknown, b: unknown, type: string): boolean {
  if (a === b) return true;
  if (a == null || b == null) return a == null && b == null;
  const kind = type.toLowerCase();
  if (["bool", "boolean"].includes(kind)) return Boolean(a) === Boolean(b);
  if (["int", "integer", "float", "double", "number"].includes(kind)) {
    const left = Number(a);
    const right = Number(b);
    if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
    return Math.abs(left - right) < 1e-9;
  }
  return String(a) === String(b);
}

export function buildDirtyPayload(
  params: ControllerParam[],
  edits: Record<string, ParamValue>
): Record<string, ParamValue> {
  const payload: Record<string, ParamValue> = {};
  for (const param of params) {
    if (!(param.name in edits)) continue;
    payload[param.name] = coerceTypedValue(edits[param.name], param);
  }
  return payload;
}

export function fieldParams(params: ControllerParam[], family: ParamFamily): ControllerParam[] {
  const order = family === "rpp" ? RPP_FIELD_ORDER : SPRAY_FIELD_ORDER;
  const byName = new Map(params.map((param) => [param.name, param]));
  return order.map((name) => byName.get(name)).filter((param): param is ControllerParam => Boolean(param));
}

export function advancedParams(params: ControllerParam[], family: ParamFamily): ControllerParam[] {
  const field = new Set<string>(family === "rpp" ? RPP_FIELD_ORDER : SPRAY_FIELD_ORDER);
  return params.filter((param) => !field.has(param.name));
}

export function groupParams(params: ControllerParam[]): { group: string; params: ControllerParam[] }[] {
  const groups = new Map<string, ControllerParam[]>();
  for (const param of params) {
    const list = groups.get(param.group) ?? [];
    list.push(param);
    groups.set(param.group, list);
  }
  return Array.from(groups.entries()).map(([group, items]) => ({ group, params: items }));
}

export function liveValueCount(params: ControllerParam[]): number {
  return params.filter((param) => param.current !== null && param.current !== undefined).length;
}
