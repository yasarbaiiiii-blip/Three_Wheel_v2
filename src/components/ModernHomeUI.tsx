// @ts-nocheck
import React, { useState, useEffect } from "react";
import { View, Text, Pressable, StyleSheet, ScrollView, Animated, PanResponder, Modal, Alert } from "react-native";
import { GestureHandlerRootView, GestureDetector, Gesture } from "react-native-gesture-handler";
import AnimatedReanimated, { useSharedValue, useAnimatedStyle, withSpring, runOnJS } from "react-native-reanimated";
import { LucideIcon, Menu, Map as MapIcon, Upload, Shield, Play, Square, Settings, Radio, Route, Grid, MapPin, Search } from "lucide-react-native";
import MapView from "./MapView"; // The wrapper MapView component

// Theme Constants
const COLORS = {
  bg: "#1c1c1c",
  surface: "#2b2b2b",
  surfaceLight: "rgba(43,43,43,0.88)",
  primary: "#f4c10c", // Safety Yellow
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
  // Extract essential props
  const {
    lines,
    importedPlan,
    systemHealth,
    telemetrySnapshot,
    missionRunning,
    onNav,
    onToggleMenu,
    onArmVehicle,
    onSetMode,
    onEstopVehicle,
    onStartPlan,
    onStopPlan,
    onClearMission,
    rtkRunning,
    rtkHealthy,
    startNtrip,
    startLora,
    stopRtk,
    selectedLineId,
    onSelectLine,
    autoOriginEnabled,
    mapSourceLines,
    alignedRefPoints,
    autoOriginReference,
    mapGeometryFrame,
    visualAlignmentItem,
    isVisualAlignmentMode,
  } = props;

  // Local State
  const [telemetryOpen, setTelemetryOpen] = useState(false);
  const [isEStopHeld, setIsEStopHeld] = useState(false);
  
  // Progress Ring Animation for E-Stop
  const estopProgress = useSharedValue(0);

  const eStopGesture = Gesture.Pan()
    .onBegin(() => {
      runOnJS(setIsEStopHeld)(true);
      estopProgress.value = withSpring(100, { damping: 20, stiffness: 90 });
    })
    .onEnd(() => {
      runOnJS(setIsEStopHeld)(false);
      estopProgress.value = withSpring(0);
    });

  // Calculate stats
  const totalLines = lines?.length || 0;
  const sprayLines = lines?.filter(l => l.entity?.is_mark).length || 0;
  const battery = telemetrySnapshot?.battery_percentage ?? "--";
  const paintLevel = 64; // Placeholder for now, telemetry doesn't have paint level yet
  const mode = systemHealth?.mode || "UNKNOWN";
  const isArmed = systemHealth?.armed || false;

  return (
    <View style={styles.container}>
      {/* 1. Map Canvas (Full Screen) */}
      <View style={[styles.mapContainer, telemetryOpen && { right: "25%" }]}>
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

      {/* 2. Top Bar (Floating Pill) */}
      <View style={styles.topBar}>
        <Pressable onPress={() => startNtrip()} style={styles.topBtn}>
          <Radio size={16} color={rtkRunning ? COLORS.success : COLORS.textMuted} />
          <Text style={styles.topBtnText}>RTK</Text>
          {rtkRunning && (
            <Pressable onPress={stopRtk} style={styles.stopBadge}>
              <Square size={10} color="#fff" fill="#fff" />
            </Pressable>
          )}
        </Pressable>
        <View style={styles.divider} />
        <Pressable onPress={() => startLora()} style={styles.topBtn}>
          <Radio size={16} color={COLORS.textMain} />
          <Text style={styles.topBtnText}>LoRa</Text>
        </Pressable>
        <View style={styles.divider} />
        <Pressable onPress={() => onNav("fields")} style={styles.topBtn}>
          <Upload size={16} color={COLORS.textMain} />
          <Text style={styles.topBtnText}>Load Plan</Text>
        </Pressable>
        <View style={styles.divider} />
        <Pressable onPress={() => onArmVehicle(!isArmed)} style={styles.topBtn}>
          <Shield size={16} color={isArmed ? COLORS.danger : COLORS.success} />
          <Text style={styles.topBtnText}>{isArmed ? "Disarm" : "Arm"}</Text>
        </Pressable>
        <View style={styles.divider} />
        <Pressable onPress={() => onSetMode(mode === "AUTO" ? "MANUAL" : "AUTO")} style={styles.topBtn}>
          <Settings size={16} color={COLORS.primary} />
          <Text style={[styles.topBtnText, { color: COLORS.primary }]}>{mode}</Text>
        </Pressable>
      </View>

      {/* 3. Left Navbar (Hamburger & Quick Tools) */}
      <View style={styles.leftNav}>
        <Pressable onPress={onToggleMenu} style={styles.navItem}>
          <Menu size={24} color={COLORS.primary} />
        </Pressable>
        <Pressable onPress={() => onNav("fields")} style={styles.navItem}>
          <Route size={20} color={COLORS.textMuted} />
        </Pressable>
        <Pressable onPress={() => onNav("settings")} style={styles.navItem}>
          <Settings size={20} color={COLORS.textMuted} />
        </Pressable>
      </View>

      {/* 4. Right Toggle Button (Line Details) */}
      {!telemetryOpen && (
        <Pressable onPress={() => setTelemetryOpen(true)} style={styles.toggleBtn}>
          <Menu size={20} color={COLORS.primary} />
          <Text style={styles.toggleText}>Telemetry</Text>
        </Pressable>
      )}

      {/* 5. 25% Telemetry Panel */}
      {telemetryOpen && (
        <View style={styles.telemetryPanel}>
          <View style={styles.panelHeader}>
            <Text style={styles.panelTitle}>Telemetry & Lines</Text>
            <Pressable onPress={() => setTelemetryOpen(false)}>
              <Square size={20} color={COLORS.textMuted} />
            </Pressable>
          </View>
          
          <ScrollView style={styles.panelScroll}>
            <View style={styles.telemetryCard}>
              <Text style={styles.cardLabel}>Battery</Text>
              <Text style={styles.cardValue}>{battery}%</Text>
            </View>
            <View style={styles.telemetryCard}>
              <Text style={styles.cardLabel}>Paint Level</Text>
              <Text style={styles.cardValue}>{paintLevel}%</Text>
            </View>
            <View style={styles.telemetryCard}>
              <Text style={styles.cardLabel}>RTK Status</Text>
              <Text style={[styles.cardValue, { color: rtkHealthy ? COLORS.success : COLORS.danger }]}>
                {rtkRunning ? (rtkHealthy ? "FIXED" : "FLOAT") : "DISCONNECTED"}
              </Text>
            </View>

            <View style={{ marginTop: 20 }}>
              <Text style={styles.panelTitle}>Line Details ({totalLines})</Text>
              {lines?.slice(0, 50).map(l => (
                <Pressable 
                  key={l.id} 
                  onPress={() => onSelectLine(l.id === selectedLineId ? null : l.id)}
                  style={[styles.lineItem, selectedLineId === l.id && styles.lineItemSelected]}
                >
                  <Text style={styles.lineText}>{l.label}</Text>
                  {l.entity?.is_mark && <View style={styles.markDot} />}
                </Pressable>
              ))}
            </View>
          </ScrollView>
        </View>
      )}

      {/* 6. Context-Aware Action Zone (Bottom Right) */}
      <View style={styles.actionZone}>
        
        {/* Clear Plan */}
        {importedPlan && (
          <Pressable onPress={onClearMission} style={styles.clearBtn}>
            <Text style={styles.clearBtnText}>Clear Plan</Text>
          </Pressable>
        )}

        {/* Floating E-Stop */}
        {missionRunning && (
          <GestureDetector gesture={eStopGesture}>
            <AnimatedReanimated.View style={styles.estopBtn}>
              <Text style={styles.estopText}>E-STOP</Text>
              <Text style={styles.estopSub}>HOLD 2s</Text>
            </AnimatedReanimated.View>
          </GestureDetector>
        )}

        {/* Mission Control Start/Stop */}
        {isArmed && (
          <Pressable 
            onPress={missionRunning ? onStopPlan : onStartPlan} 
            style={[styles.missionBtn, missionRunning && styles.missionBtnActive]}
          >
            {missionRunning ? (
              <Square size={24} color={COLORS.bg} fill={COLORS.bg} />
            ) : (
              <Play size={24} color={COLORS.bg} fill={COLORS.bg} />
            )}
          </Pressable>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.bg,
  },
  mapContainer: {
    position: "absolute",
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
  },
  topBar: {
    position: "absolute",
    top: 16,
    alignSelf: "center",
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
  topBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 8,
  },
  topBtnText: {
    color: COLORS.textMain,
    fontSize: 13,
    fontWeight: "600",
  },
  divider: {
    width: 1,
    height: 14,
    backgroundColor: COLORS.border,
    marginHorizontal: 4,
  },
  stopBadge: {
    backgroundColor: COLORS.danger,
    borderRadius: 4,
    padding: 2,
    marginLeft: 4,
  },
  leftNav: {
    position: "absolute",
    left: 16,
    top: "50%",
    transform: [{ translateY: -100 }],
    backgroundColor: COLORS.surfaceLight,
    borderWidth: 1,
    borderColor: COLORS.primaryDim,
    borderRadius: 30,
    paddingVertical: 16,
    paddingHorizontal: 12,
    gap: 22,
    alignItems: "center",
    ...SHADOW,
  },
  navItem: {
    padding: 4,
  },
  toggleBtn: {
    position: "absolute",
    right: 0,
    top: "50%",
    transform: [{ translateY: -50 }],
    backgroundColor: COLORS.surfaceLight,
    borderWidth: 1,
    borderRightWidth: 0,
    borderColor: COLORS.primaryDim,
    borderTopLeftRadius: 16,
    borderBottomLeftRadius: 16,
    padding: 12,
    flexDirection: "column",
    alignItems: "center",
    gap: 4,
  },
  toggleText: {
    color: COLORS.primary,
    fontSize: 10,
    fontWeight: "700",
    transform: [{ rotate: "-90deg" }],
    marginTop: 20,
    marginBottom: 20,
  },
  telemetryPanel: {
    position: "absolute",
    right: 0,
    top: 0,
    bottom: 0,
    width: "25%",
    backgroundColor: COLORS.surface,
    borderLeftWidth: 1,
    borderColor: COLORS.primaryDim,
    padding: 16,
    zIndex: 100,
  },
  panelHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 20,
  },
  panelTitle: {
    color: COLORS.textMain,
    fontSize: 16,
    fontWeight: "800",
  },
  panelScroll: {
    flex: 1,
  },
  telemetryCard: {
    backgroundColor: COLORS.bg,
    borderRadius: 8,
    padding: 12,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  cardLabel: {
    color: COLORS.textMuted,
    fontSize: 12,
    fontWeight: "600",
  },
  cardValue: {
    color: COLORS.textMain,
    fontSize: 18,
    fontWeight: "800",
    marginTop: 4,
  },
  lineItem: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderColor: COLORS.border,
  },
  lineItemSelected: {
    backgroundColor: COLORS.primaryDim,
  },
  lineText: {
    color: COLORS.textMain,
    fontSize: 13,
  },
  markDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: COLORS.primary,
  },
  actionZone: {
    position: "absolute",
    right: 24,
    bottom: 24,
    alignItems: "flex-end",
    gap: 16,
  },
  clearBtn: {
    backgroundColor: COLORS.surfaceLight,
    borderWidth: 1,
    borderColor: COLORS.primaryDim,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 20,
  },
  clearBtnText: {
    color: COLORS.textMain,
    fontSize: 12,
    fontWeight: "700",
  },
  estopBtn: {
    width: 78,
    height: 78,
    borderRadius: 39,
    backgroundColor: COLORS.danger,
    borderWidth: 3,
    borderColor: COLORS.textMain,
    alignItems: "center",
    justifyContent: "center",
    ...SHADOW,
  },
  estopText: {
    color: "#fff",
    fontSize: 13,
    fontWeight: "800",
  },
  estopSub: {
    color: COLORS.dangerBg,
    fontSize: 9,
    fontWeight: "600",
  },
  missionBtn: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: COLORS.primary,
    alignItems: "center",
    justifyContent: "center",
    ...SHADOW,
  },
  missionBtnActive: {
    backgroundColor: COLORS.danger,
  }
});
