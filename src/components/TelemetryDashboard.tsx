// @ts-nocheck
import React, { memo } from "react";
import { View, Text } from "react-native";
import type { TelemetrySnapshot } from "../types/plan";

/**
 * Custom comparator — only re-render when meaningful telemetry fields change.
 * This prevents the entire App.tsx tree from re-rendering at 10Hz.
 */
const areTelemetrySnapshotsEqual = (
  prev: TelemetrySnapshot | null,
  next: TelemetrySnapshot | null
): boolean => {
  if (prev === next) return true;
  if (!prev || !next) return false;
  return (
    prev.lat === next.lat &&
    prev.lon === next.lon &&
    prev.pos_n === next.pos_n &&
    prev.pos_e === next.pos_e &&
    prev.heading_ned_deg === next.heading_ned_deg &&
    prev.xtrack_m === next.xtrack_m &&
    prev.heading_err_deg === next.heading_err_deg &&
    prev.dist_to_goal_m === next.dist_to_goal_m &&
    prev.speed_m_s === next.speed_m_s &&
    prev.measured_speed_m_s === next.measured_speed_m_s &&
    prev.along_track_speed_mps === next.along_track_speed_mps &&
    prev.cross_track_speed_mps === next.cross_track_speed_mps &&
    prev.battery_pct === next.battery_pct &&
    prev.gps_fix === next.gps_fix &&
    prev.gps_fix_name === next.gps_fix_name &&
    prev.gps_sat === next.gps_sat &&
    prev.hrms === next.hrms &&
    prev.vrms === next.vrms &&
    prev.mode === next.mode &&
    prev.armed === next.armed &&
    prev.rpp_state === next.rpp_state &&
    prev.rpp_state_name === next.rpp_state_name &&
    prev.mission_state === next.mission_state &&
    prev.joystick_state === next.joystick_state &&
    prev.joystick_active === next.joystick_active &&
    prev.control_owner === next.control_owner &&
    prev.pose_age_ms === next.pose_age_ms &&
    prev.battery_v === next.battery_v &&
    prev.projection_segment_index === next.projection_segment_index &&
    prev.gps_safety_ok === next.gps_safety_ok &&
    prev.manual_resume_required === next.manual_resume_required
  );
};

type TelemetryDashboardProps = {
  snapshot: TelemetrySnapshot | null;
};

/**
 * TelemetryDashboard renders all telemetry-dependent UI.
 * Wrapped in React.memo with deep comparison so it only re-renders
 * when telemetry data actually changes, not on every parent re-render.
 */
export const TelemetryDashboard = memo(
  ({ snapshot }: TelemetryDashboardProps) => {
    if (!snapshot) {
      return (
        <View>
          <Text style={{ color: "#94a3b8", fontSize: 12 }}>
            No telemetry data
          </Text>
        </View>
      );
    }

    const lat = snapshot.lat?.toFixed(8) ?? "N/A";
    const lon = snapshot.lon?.toFixed(8) ?? "N/A";
    const gpsFix =
      snapshot.gps_fix_name ??
      (snapshot.gps_fix == null
        ? "No Fix"
        : snapshot.gps_fix === 0
        ? "No Fix"
        : snapshot.gps_fix === 1
        ? "No Fix"
        : snapshot.gps_fix === 2
        ? "2D Fix"
        : snapshot.gps_fix === 3
        ? "3D Fix"
        : snapshot.gps_fix === 4
        ? "DGPS"
        : snapshot.gps_fix === 5
        ? "RTK Float"
        : snapshot.gps_fix === 6
        ? "RTK Fixed"
        : `Fix ${snapshot.gps_fix}`);
    const sats = snapshot.gps_sat ?? 0;
    const hrms =
      snapshot.hrms != null ? (snapshot.hrms * 100).toFixed(2) : "—";
    const vrms =
      snapshot.vrms != null ? (snapshot.vrms * 100).toFixed(2) : "—";
    const xtrack =
      snapshot.xtrack_m != null ? snapshot.xtrack_m.toFixed(2) : "—";
    const headingErr =
      snapshot.heading_err_deg != null
        ? snapshot.heading_err_deg.toFixed(2)
        : "—";
    const headingDeg =
      snapshot.heading_ned_deg != null
        ? snapshot.heading_ned_deg.toFixed(2)
        : "—";
    const distGoal =
      snapshot.dist_to_goal_m != null
        ? snapshot.dist_to_goal_m.toFixed(2)
        : "—";
    const speed =
      snapshot.speed_m_s != null ? snapshot.speed_m_s.toFixed(2) : "—";
    const measuredSpeed =
      snapshot.measured_speed_m_s != null
        ? snapshot.measured_speed_m_s.toFixed(2)
        : null;
    const displaySpeed = measuredSpeed ?? speed;
    const alongTrackSpeed =
      snapshot.along_track_speed_mps != null
        ? snapshot.along_track_speed_mps.toFixed(2)
        : "—";
    const crossTrackSpeed =
      snapshot.cross_track_speed_mps != null
        ? snapshot.cross_track_speed_mps.toFixed(2)
        : "—";
    const rppState = snapshot.rpp_state_name ?? "N/A";
    const poseAge =
      snapshot.pose_age_ms != null ? snapshot.pose_age_ms.toFixed(0) : "—";
    const battV =
      snapshot.battery_v != null ? snapshot.battery_v.toFixed(2) : "—";
    const batteryPct = snapshot.battery_pct ?? 0;
    const missionStateStr = snapshot.mission_state ?? "idle";

    const gpsFixTone =
      gpsFix.toLowerCase().includes("rtk") ||
      gpsFix.toLowerCase().includes("fixed")
        ? "#10b981"
        : gpsFix.toLowerCase().includes("float")
        ? "#f59e0b"
        : "#ef4444";

    const batteryTone =
      batteryPct > 50
        ? "#10b981"
        : batteryPct > 20
        ? "#f59e0b"
        : "#ef4444";

    const missionStateTone =
      missionStateStr === "running"
        ? "#10b981"
        : missionStateStr === "paused"
        ? "#f59e0b"
        : missionStateStr === "error"
        ? "#ef4444"
        : "#94a3b8";

    return (
      <View style={{ padding: 8, gap: 6 }}>
        {/* Quick status row */}
        <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
          <TelemetryChip label="Fix" value={gpsFix} tone={gpsFixTone} />
          <TelemetryChip label="Batt" value={`${batteryPct}%`} tone={batteryTone} />
          <TelemetryChip label="Sats" value={String(sats)} tone="#94a3b8" />
        </View>

        {/* Position */}
        <View style={dashboardStyles.section}>
          <Text style={dashboardStyles.sectionTitle}>Position</Text>
          <View style={dashboardStyles.row}>
            <Text style={dashboardStyles.label}>LAT</Text>
            <Text style={dashboardStyles.value}>{lat}</Text>
          </View>
          <View style={dashboardStyles.row}>
            <Text style={dashboardStyles.label}>LON</Text>
            <Text style={dashboardStyles.value}>{lon}</Text>
          </View>
          <View style={dashboardStyles.row}>
            <Text style={dashboardStyles.label}>HRMS</Text>
            <Text style={dashboardStyles.value}>
              {hrms !== "—" ? `${hrms} cm` : "—"}
            </Text>
          </View>
          <View style={dashboardStyles.row}>
            <Text style={dashboardStyles.label}>VRMS</Text>
            <Text style={dashboardStyles.value}>
              {vrms !== "—" ? `${vrms} cm` : "—"}
            </Text>
          </View>
          <View style={dashboardStyles.row}>
            <Text style={dashboardStyles.label}>Pose Age</Text>
            <Text style={dashboardStyles.value}>
              {poseAge !== "—" ? `${poseAge} ms` : "—"}
            </Text>
          </View>
        </View>

        {/* Mission */}
        <View style={dashboardStyles.section}>
          <Text style={dashboardStyles.sectionTitle}>Mission</Text>
          <View style={dashboardStyles.row}>
            <Text style={dashboardStyles.label}>State</Text>
            <Text style={[dashboardStyles.value, { color: missionStateTone }]}>
              {missionStateStr.toUpperCase()}
            </Text>
          </View>
          <View style={dashboardStyles.row}>
            <Text style={dashboardStyles.label}>X-Track</Text>
            <Text style={dashboardStyles.value}>{xtrack} m</Text>
          </View>
          <View style={dashboardStyles.row}>
            <Text style={dashboardStyles.label}>Hdg Err</Text>
            <Text style={dashboardStyles.value}>{headingErr}°</Text>
          </View>
          <View style={dashboardStyles.row}>
            <Text style={dashboardStyles.label}>Dist Goal</Text>
            <Text style={dashboardStyles.value}>{distGoal} m</Text>
          </View>
          <View style={dashboardStyles.row}>
            <Text style={dashboardStyles.label}>Speed</Text>
            <Text style={dashboardStyles.value}>{displaySpeed} m/s</Text>
          </View>
          <View style={dashboardStyles.row}>
            <Text style={dashboardStyles.label}>Along-Trk</Text>
            <Text style={dashboardStyles.value}>{alongTrackSpeed} m/s</Text>
          </View>
          <View style={dashboardStyles.row}>
            <Text style={dashboardStyles.label}>Cross-Trk</Text>
            <Text style={dashboardStyles.value}>{crossTrackSpeed} m/s</Text>
          </View>
        </View>

        {/* Systems */}
        <View style={dashboardStyles.section}>
          <Text style={dashboardStyles.sectionTitle}>Systems</Text>
          <View style={dashboardStyles.row}>
            <Text style={dashboardStyles.label}>RPP</Text>
            <Text style={dashboardStyles.value}>{rppState}</Text>
          </View>
          <View style={dashboardStyles.row}>
            <Text style={dashboardStyles.label}>Heading</Text>
            <Text style={dashboardStyles.value}>{headingDeg}°</Text>
          </View>
        </View>

        {/* Power */}
        <View style={dashboardStyles.section}>
          <Text style={dashboardStyles.sectionTitle}>Power</Text>
          <View style={dashboardStyles.row}>
            <Text style={dashboardStyles.label}>Battery</Text>
            <Text style={[dashboardStyles.value, { color: batteryTone }]}>
              {batteryPct}% ({battV}V)
            </Text>
          </View>
        </View>
      </View>
    );
  },
  (prevProps, nextProps) =>
    areTelemetrySnapshotsEqual(prevProps.snapshot, nextProps.snapshot)
);

TelemetryDashboard.displayName = "TelemetryDashboard";

function TelemetryChip({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: string;
}) {
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        paddingHorizontal: 10,
        paddingVertical: 6,
        borderRadius: 8,
        backgroundColor: "rgba(255,255,255,0.06)",
        borderWidth: 1,
        borderColor: "rgba(255,255,255,0.08)",
      }}
    >
      <Text
        style={{
          color: "#94a3b8",
          fontSize: 9,
          fontWeight: "800",
          letterSpacing: 0.6,
          textTransform: "uppercase",
        }}
      >
        {label}
      </Text>
      <Text
        style={{
          color: tone,
          fontSize: 11,
          fontWeight: "700",
        }}
      >
        {value}
      </Text>
    </View>
  );
}

const dashboardStyles = {
  section: {
    backgroundColor: "rgba(255,255,255,0.04)",
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.06)",
    padding: 10,
    gap: 4,
  },
  sectionTitle: {
    color: "#64748b",
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 0.8,
    textTransform: "uppercase" as const,
    marginBottom: 4,
  },
  row: {
    flexDirection: "row" as const,
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 2,
  },
  label: {
    color: "#94a3b8",
    fontSize: 11,
    fontWeight: "600",
  },
  value: {
    color: "#f8fafc",
    fontSize: 11,
    fontWeight: "700",
    fontFamily: "monospace" as const,
  },
};