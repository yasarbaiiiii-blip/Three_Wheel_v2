import type { TelemetrySnapshot } from "../../types/plan";

export type RoverTelemetryFields = Pick<
  TelemetrySnapshot,
  | "lat"
  | "lon"
  | "ekf_lat"
  | "ekf_lon"
  | "heading_ned_deg"
  | "mission_state"
  | "projection_segment_index"
> | null;

export function selectRoverTelemetry(snapshot: TelemetrySnapshot | null): RoverTelemetryFields {
  if (!snapshot) return null;
  return {
    lat: snapshot.lat,
    lon: snapshot.lon,
    ekf_lat: snapshot.ekf_lat,
    ekf_lon: snapshot.ekf_lon,
    heading_ned_deg: snapshot.heading_ned_deg,
    mission_state: snapshot.mission_state,
    projection_segment_index: snapshot.projection_segment_index,
  };
}

export function roverTelemetryEqual(a: RoverTelemetryFields, b: RoverTelemetryFields): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    Object.is(a.lat, b.lat) &&
    Object.is(a.lon, b.lon) &&
    Object.is(a.ekf_lat, b.ekf_lat) &&
    Object.is(a.ekf_lon, b.ekf_lon) &&
    Object.is(a.heading_ned_deg, b.heading_ned_deg) &&
    Object.is(a.mission_state, b.mission_state) &&
    Object.is(a.projection_segment_index, b.projection_segment_index)
  );
}

function validLatitude(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= -90 && value <= 90;
}

function validLongitude(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= -180 && value <= 180;
}

/** Resolve an atomic coordinate pair: never combine one EKF coordinate with one GNSS coordinate. */
export function roverCenterFromSnapshot(
  snapshot: RoverTelemetryFields | TelemetrySnapshot | null
): { lat: number; lon: number } | null {
  if (!snapshot) return null;
  if (validLatitude(snapshot.ekf_lat) && validLongitude(snapshot.ekf_lon)) {
    return { lat: snapshot.ekf_lat, lon: snapshot.ekf_lon };
  }
  if (validLatitude(snapshot.lat) && validLongitude(snapshot.lon)) {
    return { lat: snapshot.lat, lon: snapshot.lon };
  }
  return null;
}

export function hasRoverFix(snapshot: RoverTelemetryFields | TelemetrySnapshot | null): boolean {
  return roverCenterFromSnapshot(snapshot) !== null;
}
