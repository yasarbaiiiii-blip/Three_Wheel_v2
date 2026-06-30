// @ts-nocheck
import React, { useState } from "react";
import { View, Text, Pressable, StyleSheet, ScrollView, Animated } from "react-native";
import { GestureHandlerRootView, GestureDetector, Gesture } from "react-native-gesture-handler";
import AnimatedReanimated, { useSharedValue, useAnimatedStyle, withSpring, runOnJS } from "react-native-reanimated";
import { Menu, Map as MapIcon, Upload, Shield, Play, Square, Settings, Radio, Route, Grid, MapPin, Search, X, Target, List, Pause, ChevronRightCircle, Download, LogOut, Info, PauseCircle, ChevronRight } from "lucide-react-native";
import MapView from "./MapView";

const COLORS = {
  bg: "#1c1c1c",
  surface: "#2b2b2b",
  surfaceLight: "rgba(43,43,43,0.88)",
  primary: "#f4c10c",
  primaryDim: "rgba(244,193,12,0.2)",
  textMain: "#f5f5f0",
  textMuted: "#7a7a72",
  danger: "#cc1f1f",
  dangerBg: "#f5d9d9",
  success: "#3aa15a",
  border: "rgba(255,255,255,0.1)",
};

const SHADOW = {
  shadowColor: "#000",
  shadowOffset: { width: 0, height: 4 },
  shadowOpacity: 0.3,
  shadowRadius: 5,
  elevation: 6,
};

export default function ModernHomeUI(props: any) {
  const {
    lines, importedPlan, systemHealth, telemetrySnapshot, missionRunning,
    onNav, onToggleMenu, onArmVehicle, onSetMode, onEstopVehicle,
    onStartPlan, onStopPlan, onClearMission, rtkRunning, rtkHealthy,
    startNtrip, startLora, stopRtk, selectedLineId, onSelectLine,
    autoOriginEnabled, mapSourceLines, alignedRefPoints, autoOriginReference,
    mapGeometryFrame, visualAlignmentItem, isVisualAlignmentMode,
    rtkDefaultMode = "NTRIP" // we'll use this from props or default to NTRIP
  } = props;

  const [telemetryOpen, setTelemetryOpen] = useState(false);
  const [missionControlOpen, setMissionControlOpen] = useState(false);
  const [navExpanded, setNavExpanded] = useState(false);
  const [isEStopHeld, setIsEStopHeld] = useState(false);
  
  // Progress Ring Animation for E-Stop
  const estopProgress = useSharedValue(0);

  const triggerEStop = () => {
    // E-Stop API Post based on user feedback
    fetch("http://127.0.0.1:5000/api/rover/estop", { method: "POST" }).catch(() => {});
    if (onEstopVehicle) onEstopVehicle();
  };

  const eStopGesture = Gesture.Pan()
    .onBegin(() => {
      runOnJS(setIsEStopHeld)(true);
      estopProgress.value = withSpring(100, { damping: 20, stiffness: 90 });
    })
    .onEnd(() => {
      runOnJS(setIsEStopHeld)(false);
      estopProgress.value = withSpring(0);
      if (estopProgress.value > 90) {
        runOnJS(triggerEStop)();
      }
    });

  const animatedEstopStyle = useAnimatedStyle(() => {
    return {
      borderWidth: 3,
      borderColor: COLORS.textMain,
      transform: [{ scale: 1 + estopProgress.value / 500 }]
    };
  });

  const totalLines = lines?.length || 0;
  const battery = telemetrySnapshot?.battery_percentage ?? "--";
  const mode = systemHealth?.mode || "MANUAL";
  const isArmed = systemHealth?.armed || false;

  const rightPanelWidth = (telemetryOpen || missionControlOpen) ? "25%" : 0;

  return (
    <View style={styles.container}>
      {/* 1. Map Canvas (Full Screen) */}
      <View style={[styles.mapContainer, { right: rightPanelWidth }]}>
        <MapView
          mode={visualAlignmentItem ? "templates" : "fields"}
          placedItems={visualAlignmentItem ? [visualAlignmentItem] : []}
          selectedItemIds={visualAlignmentItem && props.visualSelected ? ["visual-alignment-group"] : []}
          multiTouchMode={visualAlignmentItem ? "rotate" : "both"}
          onSelectionChange={(ids) => {
            if (isVisualAlignmentMode) {
              props.setVisualSelected?.(ids.includes("visual-alignment-group"));
            }
          }}
          onUpdatePlacedItem={(id, updates) => {
            if (!isVisualAlignmentMode || id !== "visual-alignment-group") return;
            props.setVisualAlignmentItem?.((prev) => prev ? { ...prev, ...updates } : prev);
          }}
          telemetrySnapshot={{
            lat: telemetrySnapshot?.lat,
            lon: telemetrySnapshot?.lon,
            alt: telemetrySnapshot?.alt,
            heading_ned_deg: telemetrySnapshot?.heading_ned_deg,
            pos_n: telemetrySnapshot?.pos_n,
            pos_e: telemetrySnapshot?.pos_e,
          }}
          lines={visualAlignmentItem ? [] : autoOriginEnabled && mapSourceLines ? mapSourceLines : lines}
          alignedRefPoints={alignedRefPoints}
          autoOriginReference={autoOriginReference}
          mapGeometryFrame={mapGeometryFrame}
          autoOriginEnabled={autoOriginEnabled}
          stagedVerified={false}
          visible={true}
          recenterRoverTrigger={0}
          recenterPlanTrigger={0}
          onSelectPoint={() => {}}
          onSelectLine={onSelectLine}
          selectedLineId={selectedLineId}
          showCornerPoints={true}
        />
      </View>

      {/* 2. Top Bar (Centered) */}
      <View style={styles.topBarContainer}>
         <View style={styles.topBar}>
            <Pressable onPress={() => onSetMode(mode === "AUTO" ? "MANUAL" : "AUTO")} style={styles.topBtn}>
               <Settings size={16} color={COLORS.primary} />
               <Text style={[styles.topBtnText, { color: COLORS.primary }]}>Mode: {mode}</Text>
            </Pressable>
            
            <View style={styles.divider} />
            
            <Pressable onPress={() => rtkRunning ? stopRtk() : (rtkDefaultMode === "Lora" ? startLora() : startNtrip())} style={styles.topBtn}>
               <Radio size={16} color={rtkRunning ? COLORS.success : COLORS.textMuted} />
               <Text style={styles.topBtnText}>RTK: {rtkDefaultMode}</Text>
               {rtkRunning && (
                  <View style={styles.rtkConnecting}>
                     <View style={styles.rtkDot} />
                     <Text style={styles.rtkBytes}>12 kb/s</Text>
                  </View>
               )}
            </Pressable>

            <View style={styles.divider} />
            
            <Pressable onPress={() => setMissionControlOpen(!missionControlOpen)} style={styles.topBtn}>
               <Target size={16} color={missionControlOpen ? COLORS.primary : COLORS.textMain} />
               <Text style={styles.topBtnText}>Mission Control</Text>
            </Pressable>
            
            <View style={styles.divider} />
            
            <Pressable onPress={() => setTelemetryOpen(!telemetryOpen)} style={styles.topBtn}>
               <List size={16} color={telemetryOpen ? COLORS.primary : COLORS.textMain} />
               <Text style={styles.topBtnText}>Telemetry</Text>
            </Pressable>
         </View>
      </View>

      {/* 3. Left Navbar (Top Left) */}
      <View style={styles.leftNavContainer}>
         <Pressable style={styles.leftNav} onPress={() => setNavExpanded(!navExpanded)}>
            <View style={styles.navItem}>
               <Menu size={24} color={COLORS.primary} />
            </View>
            <Pressable onPress={() => onNav("home")} style={styles.navItem}>
               <MapIcon size={20} color={COLORS.textMain} />
               {navExpanded && <Text style={styles.navText}>Main Screen</Text>}
            </Pressable>
            <Pressable onPress={() => onNav("fields")} style={styles.navItem}>
               <Grid size={20} color={COLORS.textMain} />
               {navExpanded && <Text style={styles.navText}>Field</Text>}
            </Pressable>
            <Pressable onPress={() => onNav("settings")} style={styles.navItem}>
               <Settings size={20} color={COLORS.textMain} />
               {navExpanded && <Text style={styles.navText}>Settings</Text>}
            </Pressable>
            <Pressable onPress={() => {}} style={styles.navItem}>
               <Info size={20} color={COLORS.textMain} />
               {navExpanded && <Text style={styles.navText}>How to</Text>}
            </Pressable>
            <Pressable onPress={() => {}} style={styles.navItem}>
               <LogOut size={20} color={COLORS.danger} />
               {navExpanded && <Text style={[styles.navText, { color: COLORS.danger }]}>Exit</Text>}
            </Pressable>
         </Pressable>
      </View>

      {/* 4. Right Overlays (Telemetry 60%, Mission Control 40%) */}
      {telemetryOpen && (
         <View style={styles.telemetryPanel}>
            <View style={styles.panelHeader}>
               <Text style={styles.panelTitle}>Telemetry</Text>
               <Pressable onPress={() => setTelemetryOpen(false)}>
                  <X size={20} color={COLORS.textMuted} />
               </Pressable>
            </View>
            <ScrollView style={styles.panelScroll}>
               <View style={styles.telemetryCard}>
                  <Text style={styles.cardLabel}>System Status</Text>
                  <Text style={[styles.cardValue, { color: COLORS.success }]}>Healthy Green</Text>
               </View>
               <View style={styles.telemetryCard}>
                  <Text style={styles.cardLabel}>Battery</Text>
                  <Text style={styles.cardValue}>{battery}%</Text>
               </View>
               <View style={styles.telemetryCard}>
                  <Text style={styles.cardLabel}>GPS Fix</Text>
                  <Text style={[styles.cardValue, { color: rtkHealthy ? COLORS.success : COLORS.primary }]}>
                     {rtkRunning ? (rtkHealthy ? "RTK Fixed" : "RTK Float") : "No Fix"}
                  </Text>
               </View>
               <View style={{ marginTop: 10 }}>
                  <Text style={styles.panelTitle}>Line Details</Text>
                  {lines?.slice(0, 10).map(l => (
                     <Pressable key={l.id} style={styles.lineItem}>
                        <Text style={styles.lineText}>{l.label}</Text>
                        <ChevronRight size={16} color={COLORS.textMuted} />
                     </Pressable>
                  ))}
               </View>
            </ScrollView>
         </View>
      )}

      {missionControlOpen && (
         <View style={styles.missionControlPanel}>
            {mode === "AUTO" ? (
               // Auto Mission Control
               <View style={styles.fullFlex}>
                  <View style={styles.panelHeader}>
                     <Text style={styles.panelTitle}>Mission Control</Text>
                     {!missionRunning && (
                        <Pressable onPress={() => setMissionControlOpen(false)}>
                           <X size={20} color={COLORS.textMuted} />
                        </Pressable>
                     )}
                  </View>
                  <View style={styles.missionProgressBox}>
                     <View style={styles.progressBarBg}>
                        <View style={[styles.progressBarFill, { width: '45%' }]} />
                     </View>
                     <View style={styles.progressTextRow}>
                        <Text style={styles.progressText}>Rover completed 45%</Text>
                        <Text style={styles.progressText}>Est. 12 mins left</Text>
                     </View>
                  </View>
                  <View style={styles.missionActions}>
                     <Pressable style={styles.missionActionBtn} onPress={missionRunning ? onStopPlan : onStartPlan}>
                        {missionRunning ? <Square size={20} color="#fff" fill="#fff" /> : <Play size={20} color="#fff" fill="#fff" />}
                        <Text style={styles.missionActionText}>{missionRunning ? "Stop" : "Start"}</Text>
                     </Pressable>
                     <Pressable style={styles.missionActionBtn}>
                        <Pause size={20} color="#fff" fill="#fff" />
                        <Text style={styles.missionActionText}>Pause</Text>
                     </Pressable>
                  </View>
                  <View style={[styles.missionActions, { marginTop: 12 }]}>
                     <Pressable style={styles.secondaryActionBtn}>
                        <ChevronRightCircle size={18} color={COLORS.textMain} />
                        <Text style={styles.secondaryActionText}>Next</Text>
                     </Pressable>
                     <Pressable style={styles.secondaryActionBtn}>
                        <Download size={18} color={COLORS.textMain} />
                        <Text style={styles.secondaryActionText}>Export Log</Text>
                     </Pressable>
                  </View>
               </View>
            ) : (
               // Manual Joystick Layout
               <View style={styles.fullFlex}>
                  <View style={styles.panelHeader}>
                     <Text style={styles.panelTitle}>Manual Control</Text>
                     <Pressable onPress={() => setMissionControlOpen(false)}>
                        <X size={20} color={COLORS.textMuted} />
                     </Pressable>
                  </View>
                  <View style={styles.joystickLayout}>
                     <View style={styles.analogStickBase}>
                        <View style={styles.analogStickKnob} />
                     </View>
                     <View style={styles.joystickBtns}>
                        <Pressable style={styles.joyBtn}>
                           <Text style={styles.joyBtnText}>Acquire</Text>
                        </Pressable>
                        <Pressable style={styles.joyBtn}>
                           <Text style={styles.joyBtnText}>Release</Text>
                        </Pressable>
                        <Pressable style={[styles.joyBtn, isArmed && { backgroundColor: COLORS.danger }]} onPress={() => onArmVehicle(!isArmed)}>
                           <Text style={styles.joyBtnText}>{isArmed ? "Disarm" : "Arm"}</Text>
                        </Pressable>
                     </View>
                  </View>
               </View>
            )}
         </View>
      )}

      {/* Floating E-Stop (Visible only during mission) */}
      {missionRunning && (
         <View style={styles.actionZone}>
            <GestureDetector gesture={eStopGesture}>
               <AnimatedReanimated.View style={[styles.estopBtn, animatedEstopStyle]}>
                  <Text style={styles.estopText}>E-STOP</Text>
                  <Text style={styles.estopSub}>HOLD 1.5s</Text>
               </AnimatedReanimated.View>
            </GestureDetector>
         </View>
      )}

    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.bg },
  mapContainer: { position: "absolute", top: 0, bottom: 0, left: 0 },
  topBarContainer: {
     position: "absolute",
     top: 16,
     left: 0,
     right: 0,
     alignItems: "center",
     zIndex: 50,
  },
  topBar: {
     flexDirection: "row",
     alignItems: "center",
     backgroundColor: COLORS.surfaceLight,
     borderWidth: 1,
     borderColor: COLORS.primaryDim,
     borderRadius: 999,
     paddingHorizontal: 16,
     paddingVertical: 8,
     ...SHADOW,
  },
  topBtn: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 8 },
  topBtnText: { color: COLORS.textMain, fontSize: 13, fontWeight: "600" },
  divider: { width: 1, height: 14, backgroundColor: COLORS.border, marginHorizontal: 4 },
  rtkConnecting: { flexDirection: "row", alignItems: "center", gap: 4, backgroundColor: COLORS.success + "20", paddingHorizontal: 6, borderRadius: 12 },
  rtkDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: COLORS.success },
  rtkBytes: { color: COLORS.success, fontSize: 10, fontWeight: "bold" },
  
  leftNavContainer: {
     position: "absolute",
     top: 16,
     left: 16,
     zIndex: 60,
  },
  leftNav: {
     backgroundColor: COLORS.surfaceLight,
     borderWidth: 1,
     borderColor: COLORS.primaryDim,
     borderRadius: 16,
     paddingVertical: 8,
     ...SHADOW,
  },
  navItem: { flexDirection: "row", alignItems: "center", paddingVertical: 12, paddingHorizontal: 16, gap: 12 },
  navText: { color: COLORS.textMain, fontSize: 14, fontWeight: "600" },

  telemetryPanel: {
     position: "absolute",
     right: 0,
     top: 0,
     height: "60%",
     width: "25%",
     backgroundColor: COLORS.surface,
     borderLeftWidth: 1,
     borderBottomWidth: 1,
     borderColor: COLORS.primaryDim,
     padding: 16,
     zIndex: 100,
  },
  missionControlPanel: {
     position: "absolute",
     right: 0,
     bottom: 0,
     height: "40%",
     width: "25%",
     backgroundColor: COLORS.surface,
     borderLeftWidth: 1,
     borderTopWidth: 1,
     borderColor: COLORS.primaryDim,
     padding: 16,
     zIndex: 100,
  },
  fullFlex: { flex: 1 },
  panelHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 16 },
  panelTitle: { color: COLORS.textMain, fontSize: 16, fontWeight: "800" },
  panelScroll: { flex: 1 },
  
  telemetryCard: {
     backgroundColor: COLORS.bg,
     borderRadius: 8,
     padding: 12,
     marginBottom: 8,
     borderWidth: 1,
     borderColor: COLORS.border,
  },
  cardLabel: { color: COLORS.textMuted, fontSize: 12, fontWeight: "600" },
  cardValue: { color: COLORS.textMain, fontSize: 18, fontWeight: "800", marginTop: 4 },
  
  lineItem: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 10, borderBottomWidth: 1, borderColor: COLORS.border },
  lineText: { color: COLORS.textMain, fontSize: 13 },

  missionProgressBox: { backgroundColor: COLORS.bg, borderRadius: 8, padding: 12, marginBottom: 16, borderWidth: 1, borderColor: COLORS.border },
  progressBarBg: { height: 8, backgroundColor: COLORS.surface, borderRadius: 4, marginBottom: 8, overflow: "hidden" },
  progressBarFill: { height: "100%", backgroundColor: COLORS.primary },
  progressTextRow: { flexDirection: "row", justifyContent: "space-between" },
  progressText: { color: COLORS.textMuted, fontSize: 11 },

  missionActions: { flexDirection: "row", gap: 12 },
  missionActionBtn: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, backgroundColor: COLORS.primary, paddingVertical: 12, borderRadius: 8 },
  missionActionText: { color: COLORS.bg, fontSize: 14, fontWeight: "bold" },
  
  secondaryActionBtn: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, backgroundColor: COLORS.bg, paddingVertical: 10, borderRadius: 8, borderWidth: 1, borderColor: COLORS.border },
  secondaryActionText: { color: COLORS.textMain, fontSize: 13 },

  joystickLayout: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 10 },
  analogStickBase: { width: 100, height: 100, borderRadius: 50, backgroundColor: COLORS.bg, borderWidth: 2, borderColor: COLORS.border, alignItems: "center", justifyContent: "center" },
  analogStickKnob: { width: 40, height: 40, borderRadius: 20, backgroundColor: COLORS.surfaceLight, borderWidth: 1, borderColor: COLORS.primaryDim },
  
  joystickBtns: { gap: 12, flex: 1, marginLeft: 20 },
  joyBtn: { backgroundColor: COLORS.bg, paddingVertical: 12, borderRadius: 8, alignItems: "center", borderWidth: 1, borderColor: COLORS.border },
  joyBtnText: { color: COLORS.textMain, fontSize: 13, fontWeight: "bold" },

  actionZone: { position: "absolute", right: "27%", bottom: 32, alignItems: "center" },
  estopBtn: { width: 86, height: 86, borderRadius: 43, backgroundColor: COLORS.danger, alignItems: "center", justifyContent: "center", ...SHADOW },
  estopText: { color: "#fff", fontSize: 14, fontWeight: "900" },
  estopSub: { color: COLORS.dangerBg, fontSize: 10, fontWeight: "700" },
});
