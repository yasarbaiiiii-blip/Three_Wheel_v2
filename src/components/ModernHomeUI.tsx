// @ts-nocheck
import React, { useState, useEffect } from "react";
import { View, Text, Pressable, StyleSheet, ScrollView, Animated, Platform, Modal, TextInput } from "react-native";
import { GestureHandlerRootView, GestureDetector, Gesture } from "react-native-gesture-handler";
import AnimatedReanimated, { useSharedValue, useAnimatedStyle, withSpring, runOnJS } from "react-native-reanimated";
import { Battery, Crosshair, Navigation, LocateFixed, Route, Wifi, Zap, Hexagon, Circle, ShieldAlert, Check, X, Menu, Play, Square, Pause, SkipForward, Download, MonitorPlay } from "lucide-react-native";
import { ManualJoystick } from "./ManualJoystick";
import { pauseMission, nextMission, exportLog } from "../api/missionApi";
import { MapView } from "./MapView";

// Using 127.0.0.1:5001 as fallback if window location is unavailable
const getApiBase = () => {
  if (typeof window !== "undefined" && window.location && window.location.hostname) {
    const host = window.location.hostname;
    if (host && host !== "localhost" && host !== "127.0.0.1") {
      return `http://${host}:5001`;
    }
  }
  return "http://127.0.0.1:5001";
};

// Theme Constants
const COLORS = {
  bgBase: "#09090b",
  panelBg: "#18181b",
  panelBorder: "rgba(255, 255, 255, 0.08)",
  textMain: "#f8fafc",
  textMuted: "#94a3b8",
  accentBrand: "#3b82f6",
  accentHover: "#2563eb",
  danger: "#ef4444",
  success: "#10b981",
  warning: "#f59e0b",
  overlay: "rgba(0, 0, 0, 0.4)",
};

const SHADOWS = {
  glow: {
    shadowColor: COLORS.accentBrand,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.4,
    shadowRadius: 12,
    elevation: 8,
  },
  panel: {
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.5,
    shadowRadius: 16,
    elevation: 10,
  }
};

const FloatingEStop = ({ visible, onTrigger }) => {
  const scale = useSharedValue(1);
  const progress = useSharedValue(0);
  
  const holdGesture = Gesture.Pan()
    .onBegin(() => {
      scale.value = withSpring(1.1);
      progress.value = withSpring(1, { duration: 1500 });
    })
    .onTouchesUp(() => {
      if (progress.value > 0.95) {
        runOnJS(onTrigger)();
      }
      scale.value = withSpring(1);
      progress.value = withSpring(0);
    });

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }]
  }));

  const progressStyle = useAnimatedStyle(() => ({
    height: `${progress.value * 100}%`,
    opacity: progress.value
  }));

  if (!visible) return null;

  return (
    <View style={styles.estopContainer} pointerEvents="box-none">
      <GestureDetector gesture={holdGesture}>
        <AnimatedReanimated.View style={[styles.estopButton, animatedStyle]}>
          <AnimatedReanimated.View style={[styles.estopProgressFill, progressStyle]} />
          <ShieldAlert size={36} color="#fff" strokeWidth={2.5} style={{ zIndex: 10 }} />
          <Text style={styles.estopText}>E-STOP</Text>
          <Text style={styles.estopSubText}>HOLD 1.5s</Text>
        </AnimatedReanimated.View>
      </GestureDetector>
    </View>
  );
};

export default function ModernHomeUI(props) {
  const {
    lines = [], importedPlan, systemHealth, telemetrySnapshot, missionRunning,
    onNav, onToggleMenu, onArmVehicle, onSetMode, onEstopVehicle,
    onStartPlan, onStopPlan, onClearMission, rtkRunning, rtkHealthy,
    startNtrip, startLora, stopRtk, selectedLineId, onSelectLine,
    autoOriginEnabled, mapSourceLines, alignedRefPoints, autoOriginReference,
    mapGeometryFrame, visualAlignmentItem, isVisualAlignmentMode,
    rtkDefaultMode = "NTRIP", virtualJoystick, onPausePlan
  } = props;

  // Local UI State
  const [showTelemetry, setShowTelemetry] = useState(true);
  const [showMissionControl, setShowMissionControl] = useState(true);
  const [navExpanded, setNavExpanded] = useState(false);
  const [isArmed, setIsArmed] = useState(systemHealth?.armed || false);
  const [visualSelected, setVisualSelected] = useState(false);

  let mode = systemHealth?.mode?.toUpperCase() || "MANUAL";
  if (mode === "AUTO" || mode === "MISSION") mode = "OFFBOARD"; // Map legacy 'AUTO'/'MISSION' to 'OFFBOARD'

  const batteryPct = telemetrySnapshot?.battery_pct ?? 0;
  const missionProgress = lines.length > 0 ? Math.min(100, Math.round(((telemetrySnapshot?.projection_segment_index || 0) / lines.length) * 100)) : 0;

  // Derived Telemetry Values
  const lat = telemetrySnapshot?.lat?.toFixed(6) ?? "N/A";
  const lon = telemetrySnapshot?.lon?.toFixed(6) ?? "N/A";
  const gpsFix = telemetrySnapshot?.gps_fix_name ?? "No Fix";
  const sats = telemetrySnapshot?.gps_sat ?? 0;
  const hrms = telemetrySnapshot?.hrms?.toFixed(2) ?? "0.00";
  const vrms = telemetrySnapshot?.vrms?.toFixed(2) ?? "0.00";
  const missionStateStr = telemetrySnapshot?.state ?? (missionRunning ? "running" : "idle");
  const xtrack = telemetrySnapshot?.xtrack_m?.toFixed(2) ?? "0.00";
  const headingErr = telemetrySnapshot?.heading_err_deg?.toFixed(1) ?? "0.0";
  const distGoal = telemetrySnapshot?.dist_to_goal_m?.toFixed(1) ?? "0.0";
  const speed = telemetrySnapshot?.speed_m_s?.toFixed(2) ?? "0.00";
  const rppState = telemetrySnapshot?.rpp_state_name ?? "N/A";
  const fcuConn = systemHealth?.fcu_connected ? "Connected" : "Disconnected";
  const poseAge = telemetrySnapshot?.pose_age_ms ?? 0;
  const battV = telemetrySnapshot?.battery_v?.toFixed(1) ?? "0.0";
  // Ampere not explicitly in schema, show N/A
  const battA = "N/A";

  useEffect(() => {
    if (systemHealth?.armed !== undefined) setIsArmed(systemHealth.armed);
  }, [systemHealth?.armed]);

  const handleEStop = () => {
    if (onEstopVehicle) onEstopVehicle();
    fetch(`${getApiBase()}/api/rover/estop`, { method: "POST" }).catch(console.error);
  };

  const handlePause = () => {
    if (onPausePlan) onPausePlan();
    else pauseMission(getApiBase()).catch(console.error);
  };

  const handleNext = () => {
    nextMission(getApiBase()).catch(console.error);
  };

  const handleExport = () => {
    exportLog(getApiBase()).catch(console.error);
  };

  const handleAcquire = () => {
    if (virtualJoystick) virtualJoystick.acquire();
  };

  const handleRelease = () => {
    if (virtualJoystick) virtualJoystick.release();
  };

  const renderTopBar = () => (
    <View style={styles.topBar} pointerEvents="box-none">
      <Pressable style={styles.navToggle} onPress={() => setNavExpanded(!navExpanded)}>
        <Menu color="#fff" size={24} />
      </Pressable>

      <View style={styles.topBarCenterWrapper} pointerEvents="box-none">
        <View style={styles.topBarCenter}>
        <Pressable 
          style={[styles.pillButton, mode === "OFFBOARD" ? styles.pillActiveBrand : styles.pillActiveSecondary]}
          onPress={() => {
            if (onSetMode) onSetMode("MANUAL");
            fetch(`${getApiBase()}/api/set_mode`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ mode: "MANUAL" })
            }).catch(console.error);
          }}
        >
          <Hexagon color="#fff" size={16} fill={mode === "OFFBOARD" ? "#fff" : "transparent"} />
          <Text style={styles.pillText}>{mode}</Text>
        </Pressable>

        <View style={styles.divider} />

        <Pressable 
          style={[styles.pillButton, rtkRunning ? styles.pillActiveSuccess : styles.pillInactive]}
          onPress={() => {
            if (rtkRunning) stopRtk && stopRtk();
            else rtkDefaultMode.toLowerCase() === "lora" ? startLora && startLora() : startNtrip && startNtrip();
          }}
        >
          <Wifi color={rtkHealthy ? COLORS.success : "#fff"} size={16} />
          <Text style={styles.pillText}>RTK: {rtkDefaultMode}</Text>
        </Pressable>

        <View style={styles.divider} />

        <Pressable 
          style={[styles.pillButton, showMissionControl ? styles.pillActiveBrand : styles.pillInactive]}
          onPress={() => setShowMissionControl(!showMissionControl)}
        >
          <Route color="#fff" size={16} />
          <Text style={styles.pillText}>Mission Control</Text>
        </Pressable>

        <View style={styles.divider} />

        <Pressable 
          style={[styles.pillButton, showTelemetry ? styles.pillActiveBrand : styles.pillInactive]}
          onPress={() => setShowTelemetry(!showTelemetry)}
        >
          <MonitorPlay color="#fff" size={16} />
          <Text style={styles.pillText}>Telemetry</Text>
        </Pressable>
        </View>
      </View>
    </View>
  );

  const renderNavbar = () => (
    <AnimatedReanimated.View style={[styles.navbar, { width: navExpanded ? 320 : 70 }]}>
      {[
        { id: "main", icon: Crosshair, label: "Main Screen" },
        { id: "fields", icon: LocateFixed, label: "Fields" },
        { id: "settings", icon: Navigation, label: "Settings" },
        { id: "howto", icon: Circle, label: "How to" }
      ].map(item => (
        <Pressable 
          key={item.id} 
          style={[styles.navItem, item.id === "main" && styles.navItemActive]}
          onPress={() => {
            if (item.id === "settings") onNav("settings");
            if (item.id === "fields") onNav("fields");
            if (item.id === "howto") onNav("howto");
          }}
        >
          <item.icon color={item.id === "main" ? COLORS.accentBrand : COLORS.textMuted} size={24} />
          {navExpanded && <Text style={[styles.navLabel, item.id === "main" && { color: COLORS.textMain }]}>{item.label}</Text>}
        </Pressable>
      ))}
      <View style={{ flex: 1 }} />
      <Pressable style={styles.navItem} onPress={() => onNav("connection")}>
        <X color={COLORS.danger} size={24} />
        {navExpanded && <Text style={[styles.navLabel, { color: COLORS.danger }]}>Exit</Text>}
      </Pressable>
    </AnimatedReanimated.View>
  );

  const renderTelemetrySection = () => {
    if (!showTelemetry) return null;
    return (
      <View style={[styles.rightPanelBase, styles.telemetryPanel]}>
        <View style={styles.panelHeader}>
          <Text style={styles.panelTitle}>Telemetry Data</Text>
          <Pressable onPress={() => setShowTelemetry(false)}>
            <X color={COLORS.textMuted} size={18} />
          </Pressable>
        </View>
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 10 }} showsVerticalScrollIndicator={false}>
          {/* Section 1: Robot Status */}
          <View style={styles.telemetrySection}>
            <Text style={styles.sectionHeader}>Robot Status</Text>
            <View style={styles.dataGrid}>
              <View style={styles.dataCell}><Text style={styles.dataLabel}>LAT</Text><Text style={styles.dataVal}>{lat}</Text></View>
              <View style={styles.dataCell}><Text style={styles.dataLabel}>LON</Text><Text style={styles.dataVal}>{lon}</Text></View>
              <View style={styles.dataCell}><Text style={styles.dataLabel}>GPS FIX</Text><Text style={styles.dataVal}>{gpsFix}</Text></View>
              <View style={styles.dataCell}><Text style={styles.dataLabel}>SATS</Text><Text style={styles.dataVal}>{sats}</Text></View>
              <View style={styles.dataCell}><Text style={styles.dataLabel}>HRMS</Text><Text style={styles.dataVal}>{hrms}m</Text></View>
              <View style={styles.dataCell}><Text style={styles.dataLabel}>VRMS</Text><Text style={styles.dataVal}>{vrms}m</Text></View>
            </View>
          </View>

          {/* Section 2: Mission State */}
          <View style={styles.telemetrySection}>
            <Text style={styles.sectionHeader}>Mission State</Text>
            <View style={styles.stateWrapper}>
              <View style={[styles.stateIndicator, { backgroundColor: missionStateStr === 'running' ? COLORS.success : COLORS.warning }]} />
              <Text style={styles.stateText}>{missionStateStr.toUpperCase()}</Text>
            </View>
          </View>

          {/* Section 3: Mission Status */}
          <View style={styles.telemetrySection}>
            <Text style={styles.sectionHeader}>Mission Status</Text>
            <View style={styles.dataGrid}>
              <View style={styles.dataCell}><Text style={styles.dataLabel}>X-TRACK</Text><Text style={styles.dataVal}>{xtrack}m</Text></View>
              <View style={styles.dataCell}><Text style={styles.dataLabel}>HDG ERR</Text><Text style={styles.dataVal}>{headingErr}°</Text></View>
              <View style={styles.dataCell}><Text style={styles.dataLabel}>DIST GOAL</Text><Text style={styles.dataVal}>{distGoal}m</Text></View>
              <View style={styles.dataCell}><Text style={styles.dataLabel}>SPEED</Text><Text style={styles.dataVal}>{speed}m/s</Text></View>
              <View style={styles.dataCell}><Text style={styles.dataLabel}>RPP STATE</Text><Text style={styles.dataVal}>{rppState}</Text></View>
              <View style={styles.dataCell}><Text style={styles.dataLabel}>FCU CONN</Text><Text style={styles.dataVal}>{fcuConn}</Text></View>
              <View style={styles.dataCell}><Text style={styles.dataLabel}>POSE AGE</Text><Text style={styles.dataVal}>{poseAge}ms</Text></View>
            </View>
          </View>

          {/* Section 4: Battery */}
          <View style={[styles.telemetrySection, { borderBottomWidth: 0 }]}>
            <Text style={styles.sectionHeader}>Battery Health</Text>
            <View style={styles.dataGrid}>
              <View style={styles.dataCell}><Text style={styles.dataLabel}>VOLTAGE</Text><Text style={styles.dataVal}>{battV}v</Text></View>
              <View style={styles.dataCell}><Text style={styles.dataLabel}>AMPERE</Text><Text style={styles.dataVal}>{battA}</Text></View>
              <View style={styles.dataCell}><Text style={styles.dataLabel}>LEVEL</Text><Text style={styles.dataVal}>{batteryPct}%</Text></View>
            </View>
          </View>
        </ScrollView>
      </View>
    );
  };

  const renderJoystickPanel = () => {
    // Hidden if not MANUAL mode, or if mission is running
    if (mode !== "MANUAL" || missionRunning) return null;
    
    return (
      <View style={[styles.rightPanelBase, styles.joystickPanel]}>
        <View style={styles.panelHeader}>
          <Text style={styles.panelTitle}>Manual Control</Text>
          {/* No X button needed since it sits underneath Mission Control or is toggled by Mode */}
        </View>
        <View style={styles.joystickContainer}>
          <ManualJoystick 
            onChange={(vals) => {
              if (virtualJoystick) virtualJoystick.setIntent(vals.forward, vals.yaw);
            }}
            onRelease={() => {
              if (virtualJoystick) virtualJoystick.setIntent(0, 0);
            }}
            size={180}
            knobSize={65}
            disabled={!isArmed}
          />
        </View>
        <View style={styles.manualActions}>
          <View style={{ flexDirection: "row", gap: 10, marginBottom: 12 }}>
            <Pressable style={[styles.actionBtnSolid, { backgroundColor: COLORS.accentBrand }]} onPress={handleAcquire}>
              <Text style={[styles.actionBtnTextSec, { color: "#fff" }]}>ACQUIRE</Text>
            </Pressable>
            <Pressable style={[styles.actionBtnSolid, { backgroundColor: COLORS.danger }]} onPress={handleRelease}>
              <Text style={[styles.actionBtnTextSec, { color: "#fff" }]}>RELEASE</Text>
            </Pressable>
          </View>
          <Pressable 
            style={[styles.armButton, isArmed ? styles.armActive : styles.armInactive]}
            onPress={() => {
              onArmVehicle(!isArmed);
              setIsArmed(!isArmed);
            }}
          >
            <ShieldAlert color="#fff" size={20} />
            <Text style={styles.armBtnText}>{isArmed ? "DISARM VEHICLE" : "ARM VEHICLE"}</Text>
          </Pressable>
        </View>
      </View>
    );
  };

  const renderMissionControl = () => {
    if (!showMissionControl) return null;

    // Auto Mode Mission Control
    return (
      <View style={[styles.rightPanelBase, styles.missionPanel]}>
        <View style={styles.panelHeader}>
          <Text style={styles.panelTitle}>Mission Progress</Text>
          {!missionRunning && (
            <Pressable onPress={() => setShowMissionControl(false)}>
              <X color={COLORS.textMuted} size={18} />
            </Pressable>
          )}
        </View>
        
        <View style={styles.progressSection}>
          <View style={styles.progressHeader}>
            <Text style={styles.progressLabel}>Rover completed {missionProgress}%</Text>
            <Text style={styles.progressTime}>--:-- ETA</Text>
          </View>
          <View style={styles.progressBarTrack}>
            <View style={[styles.progressBarFill, { width: `${missionProgress}%` }]} />
          </View>
        </View>

        <View style={styles.missionActionsGrid}>
          <Pressable 
            style={[styles.gridBtn, missionRunning ? styles.gridBtnDanger : styles.gridBtnBrand]}
            onPress={missionRunning ? onStopPlan : onStartPlan}
          >
            {missionRunning ? <Square color="#fff" size={22} /> : <Play color="#fff" size={22} />}
            <Text style={styles.gridBtnText}>{missionRunning ? "STOP" : "START"}</Text>
          </Pressable>

          <Pressable style={styles.gridBtnSecondary} onPress={handlePause}>
            <Pause color="#fff" size={22} />
            <Text style={styles.gridBtnText}>PAUSE</Text>
          </Pressable>

          <Pressable style={styles.gridBtnSecondary} onPress={handleNext}>
            <SkipForward color="#fff" size={22} />
            <Text style={styles.gridBtnText}>NEXT</Text>
          </Pressable>

          <Pressable style={styles.gridBtnSecondary} onPress={handleExport}>
            <Download color="#fff" size={22} />
            <Text style={styles.gridBtnText}>EXPORT LOG</Text>
          </Pressable>
        </View>
      </View>
    );
  };

  return (
    <GestureHandlerRootView style={styles.container}>
      {/* Map Layer */}
      <View style={{ ...StyleSheet.absoluteFillObject, zIndex: 1 }}>
        <MapView
          mode={visualAlignmentItem ? "templates" : "fields"}
          placedItems={visualAlignmentItem ? [visualAlignmentItem] : []}
          selectedItemIds={visualAlignmentItem && visualSelected ? ["visual-alignment-group"] : []}
          multiTouchMode={visualAlignmentItem ? "rotate" : "both"}
          onSelectionChange={(ids) => {
            if (isVisualAlignmentMode) {
              setVisualSelected(ids.includes("visual-alignment-group"));
            }
          }}
          onUpdatePlacedItem={(id, updates) => {
            if (!isVisualAlignmentMode || id !== "visual-alignment-group") return;
            if (props.setVisualAlignmentItem) {
              props.setVisualAlignmentItem((prev) => {
                if (!prev) return prev;
                return { ...prev, ...updates };
              });
            }
          }}
          telemetrySnapshot={telemetrySnapshot}
          lines={
            visualAlignmentItem
              ? []
              : autoOriginEnabled && mapSourceLines
                ? mapSourceLines
                : lines
          }
          alignedRefPoints={alignedRefPoints}
          autoOriginReference={autoOriginReference}
          mapGeometryFrame={mapGeometryFrame}
          autoOriginEnabled={autoOriginEnabled}
          stagedVerified={false}
          visible={true}
          recenterRoverTrigger={props.recenterRoverCount}
          recenterPlanTrigger={props.recenterPlanCount}
          onSelectPoint={props.onSelectPoint}
        />
      </View>
      
      {/* HUD Layer */}
      <View style={styles.hudLayer} pointerEvents="box-none">
        {renderTopBar()}
        {renderNavbar()}
        {renderTelemetrySection()}
        {renderJoystickPanel()}
        {renderMissionControl()}
        <FloatingEStop visible={missionRunning || isArmed} onTrigger={handleEStop} />
      </View>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#000" },
  hudLayer: { ...StyleSheet.absoluteFillObject, zIndex: 10, padding: 20 },
  
  topBar: {
    position: "absolute",
    top: 20,
    left: 20,
    right: 20,
    height: 56,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    zIndex: 100,
  },
  topBarCenterWrapper: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  topBarCenter: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: COLORS.panelBg,
    borderRadius: 30,
    padding: 6,
    borderWidth: 1,
    borderColor: COLORS.panelBorder,
    ...SHADOWS.panel,
  },
  navToggle: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: COLORS.panelBg,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: COLORS.panelBorder,
    ...SHADOWS.panel,
  },
  pillButton: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 24,
    gap: 8,
  },
  pillActiveBrand: { backgroundColor: COLORS.accentBrand },
  pillActiveSuccess: { backgroundColor: "rgba(16, 185, 129, 0.2)", borderWidth: 1, borderColor: "rgba(16, 185, 129, 0.5)" },
  pillActiveSecondary: { backgroundColor: "rgba(255, 255, 255, 0.15)" },
  pillInactive: { backgroundColor: "transparent" },
  pillText: { color: "#fff", fontWeight: "600", fontSize: 13, textTransform: "uppercase", letterSpacing: 0.5 },
  divider: { width: 1, height: 20, backgroundColor: "rgba(255, 255, 255, 0.2)", marginHorizontal: 4 },

  navbar: {
    position: "absolute",
    left: 20,
    top: 90,
    bottom: 20,
    backgroundColor: COLORS.panelBg,
    borderRadius: 24,
    borderWidth: 1,
    borderColor: COLORS.panelBorder,
    paddingVertical: 20,
    alignItems: "center",
    justifyContent: "center",
    gap: 20,
    ...SHADOWS.panel,
    overflow: "hidden",
    zIndex: 90,
  },
  navItem: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    width: "100%",
    paddingVertical: 12,
    gap: 16,
  },
  navItemActive: {
    borderLeftWidth: 3,
    borderLeftColor: COLORS.accentBrand,
    backgroundColor: "rgba(59, 130, 246, 0.1)",
  },
  navLabel: { color: COLORS.textMuted, fontSize: 14, fontWeight: "600" },

  rightPanelBase: {
    position: "absolute",
    right: 20,
    width: 320,
    backgroundColor: COLORS.panelBg,
    borderRadius: 24,
    borderWidth: 1,
    borderColor: COLORS.panelBorder,
    padding: 20,
    ...SHADOWS.panel,
    overflow: "hidden",
  },
  telemetryPanel: { top: 20, height: "58%" },
  missionPanel: { bottom: 20, height: "38%" },
  joystickPanel: { bottom: 20, height: "38%" },
  
  panelHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 16 },
  panelTitle: { color: "#fff", fontSize: 16, fontWeight: "700", letterSpacing: 0.5 },

  telemetrySection: {
    marginBottom: 16,
    paddingBottom: 16,
    borderBottomWidth: 1,
    borderBottomColor: "rgba(255, 255, 255, 0.1)",
  },
  sectionHeader: { color: COLORS.textMuted, fontSize: 11, fontWeight: "800", textTransform: "uppercase", letterSpacing: 1, marginBottom: 12 },
  dataGrid: { flexDirection: "row", flexWrap: "wrap", gap: 12 },
  dataCell: { width: "45%" },
  dataLabel: { color: "rgba(255, 255, 255, 0.5)", fontSize: 10, fontWeight: "700", marginBottom: 4 },
  dataVal: { color: "#fff", fontSize: 14, fontWeight: "600", fontFamily: Platform.OS === "ios" ? "Courier" : "monospace" },

  stateWrapper: { flexDirection: "row", alignItems: "center", gap: 10, backgroundColor: "rgba(255, 255, 255, 0.05)", padding: 12, borderRadius: 12 },
  stateIndicator: { width: 10, height: 10, borderRadius: 5 },
  stateText: { color: "#fff", fontSize: 14, fontWeight: "700", letterSpacing: 1 },

  joystickContainer: { flex: 1, alignItems: "center", justifyContent: "center", minHeight: 180 },
  manualActions: { marginTop: 10 },
  actionBtnSecondary: { flex: 1, backgroundColor: "rgba(255, 255, 255, 0.1)", height: 44, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  actionBtnSolid: { flex: 1, height: 44, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  actionBtnTextSec: { color: "#fff", fontWeight: "800", fontSize: 13, letterSpacing: 1 },
  armButton: { flexDirection: "row", height: 50, borderRadius: 16, alignItems: "center", justifyContent: "center", gap: 10 },
  armActive: { backgroundColor: COLORS.danger },
  armInactive: { backgroundColor: "rgba(255, 255, 255, 0.1)" },
  armBtnText: { color: "#fff", fontWeight: "800", fontSize: 14, letterSpacing: 1 },

  progressSection: { marginBottom: 20 },
  progressHeader: { flexDirection: "row", justifyContent: "space-between", marginBottom: 8 },
  progressLabel: { color: "#fff", fontSize: 13, fontWeight: "600" },
  progressTime: { color: COLORS.textMuted, fontSize: 12, fontWeight: "500" },
  progressBarTrack: { height: 8, backgroundColor: "rgba(255, 255, 255, 0.1)", borderRadius: 4, overflow: "hidden" },
  progressBarFill: { height: "100%", backgroundColor: COLORS.accentBrand },

  missionActionsGrid: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  gridBtn: { width: "48%", height: 60, borderRadius: 16, alignItems: "center", justifyContent: "center", gap: 6 },
  gridBtnBrand: { backgroundColor: COLORS.accentBrand },
  gridBtnDanger: { backgroundColor: COLORS.danger },
  gridBtnSecondary: { width: "48%", height: 60, backgroundColor: "rgba(255, 255, 255, 0.1)", borderRadius: 16, alignItems: "center", justifyContent: "center", gap: 6 },
  gridBtnText: { color: "#fff", fontSize: 11, fontWeight: "800", letterSpacing: 0.5 },

  estopContainer: { position: "absolute", bottom: 40, alignSelf: "center", alignItems: "center", zIndex: 9999 },
  estopButton: { width: 100, height: 100, borderRadius: 50, backgroundColor: "rgba(220, 38, 38, 0.8)", borderWidth: 4, borderColor: "#fecaca", alignItems: "center", justifyContent: "center", overflow: "hidden", ...SHADOWS.glow },
  estopProgressFill: { position: "absolute", bottom: 0, left: 0, right: 0, backgroundColor: COLORS.danger },
  estopText: { color: "#fff", fontSize: 16, fontWeight: "900", marginTop: 4 },
  estopSubText: { color: "rgba(255, 255, 255, 0.7)", fontSize: 10, fontWeight: "700" }
});
