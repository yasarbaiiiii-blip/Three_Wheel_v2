// @ts-nocheck
import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { View, Text, Pressable, StyleSheet, ScrollView, Animated, Platform, Modal, TextInput, Dimensions, Alert, useWindowDimensions } from "react-native";
import { GestureDetector, Gesture } from "react-native-gesture-handler";
import AnimatedReanimated, { useSharedValue, useAnimatedStyle, useAnimatedProps, withSpring, withTiming, cancelAnimation, Easing, runOnJS, Keyframe } from "react-native-reanimated";
import Svg, { Circle as SvgCircle, Line, Polygon, G, Text as SvgText, Path, Polyline } from "react-native-svg";
import { Battery, Crosshair, Navigation, LocateFixed, Route, Wifi, Hexagon, Circle, ShieldAlert, X, Menu, Play, Square, Pause, SkipForward, Download, MonitorPlay, MapPin, Satellite, Gauge, Activity, Radio, Gamepad2, Target, Zap, Map as MapIcon, Tractor, Maximize2, LayoutGrid, RadioTower, LogOut, Check, Pencil, Undo2, Layers, ChevronRight, Ruler, Spline, LayoutList } from "lucide-react-native";
import { ManualJoystick } from "./ManualJoystick";
import { Compass } from "./Compass";
import { Navbar } from "./Navbar";
import { pauseMission, nextMission, exportLog } from "../api/missionApi";
import { MapView } from "./MapView";
import { canAcquireJoystick as canAcquireJoystickForState } from "../utils/joystickFrontendSafety";
import { getPlanLineSegmentKind, isSegmentKindVisible } from "../utils/curveGeometry";
import * as pathApi from "../api/pathApi";
import { MissionLayerPills } from "./fields/MissionLayerPills";
import { nonEmptyMissionLayers } from "../utils/missionLayerAssignment";
import { EMPTY_RTK_STATUS, hasLiveCorrections, rtkStatusLabel } from "../api/rtkStatus";
import { AppErrorBoundary } from "./AppErrorBoundary";

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
  panelSolid: "#18181b",
  cardSolid: "#1f1f24",
  surfaceSolid: "#252529",
  navSolid: "#111114",
  panelBorder: "#2e2e34",
  textMain: "#f8fafc",
  textMuted: "#94a3b8",
  textDim: "#64748b",
  accentBrand: "#f4c10c",
  accentHover: "#d4a50a",
  accentText: "#1c1c1c",
  accentMuted: "#2e2a18",
  accentBorder: "#6b5a12",
  danger: "#ef4444",
  dangerMuted: "#3d1818",
  dangerBorder: "#7f2a2a",
  success: "#10b981",
  successMuted: "#143d30",
  successBorder: "#1f6b4f",
  warning: "#f59e0b",
  warningMuted: "#3d2e14",
  warningBorder: "#7a5a12",
  overlay: "#09090be6",
  iconBrand: "#3d3618",
  iconSuccess: "#1a3d30",
  iconDanger: "#3d1a1a",
  iconWarning: "#3d2e14",
  iconMuted: "#2e2e34",
  pillSecondary: "#35353c",
};

// Map tool dropdown metrics — popovers get an explicit width so their tile rows
// never wrap (an absolutely positioned popover has no parent width to size against).
const MENU_TILE_GAP = 8;
const MENU_POPOVER_CHROME = 20; // 8px padding + 1px border per side, plus slack
const MENU_LAYER_TILE_W = 72;
const MENU_MODE_TILE_W = 150;
const menuPopoverWidthFor = (count, tileWidth) =>
  count * tileWidth + Math.max(0, count - 1) * MENU_TILE_GAP + MENU_POPOVER_CHROME;

const iconTintFor = (tone) => {
  if (tone === COLORS.success) return COLORS.iconSuccess;
  if (tone === COLORS.danger) return COLORS.iconDanger;
  if (tone === COLORS.warning) return COLORS.iconWarning;
  if (tone === COLORS.accentBrand) return COLORS.iconBrand;
  return COLORS.iconMuted;
};

const pillBgFor = (tone) => {
  if (tone === COLORS.success) return COLORS.successMuted;
  if (tone === COLORS.danger) return COLORS.dangerMuted;
  if (tone === COLORS.warning) return COLORS.warningMuted;
  if (tone === COLORS.accentBrand) return COLORS.accentMuted;
  return COLORS.surfaceSolid;
};

const pillBorderFor = (tone) => {
  if (tone === COLORS.success) return COLORS.successBorder;
  if (tone === COLORS.danger) return COLORS.dangerBorder;
  if (tone === COLORS.warning) return COLORS.warningBorder;
  if (tone === COLORS.accentBrand) return COLORS.accentBorder;
  return COLORS.panelBorder;
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
  },
  card: {
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 6,
    elevation: 3,
  },
};

const PanelHeader = ({ icon: Icon, title, subtitle, onClose, accent = COLORS.accentBrand, live = false }) => (
  <View style={styles.panelHeader}>
    <View style={styles.panelHeaderLeft}>
      <View style={[styles.panelIconWrap, { backgroundColor: iconTintFor(accent), borderColor: pillBorderFor(accent) }]}>
        <Icon color={accent} size={18} strokeWidth={2.2} />
      </View>
      <View style={{ flex: 1 }}>
        <View style={styles.panelTitleRow}>
          <Text style={styles.panelTitle}>{title}</Text>
          {live && (
            <View style={styles.liveBadge}>
              <View style={styles.liveDot} />
              <Text style={styles.liveText}>LIVE</Text>
            </View>
          )}
        </View>
        {subtitle ? <Text style={styles.panelSubtitle}>{subtitle}</Text> : null}
      </View>
    </View>
    {onClose ? (
      <Pressable style={styles.panelCloseBtn} onPress={onClose} hitSlop={8}>
        <X color={COLORS.textMuted} size={16} />
      </Pressable>
    ) : null}
  </View>
);

// ── Map tool dropdown building blocks (Mark / Layers popovers) ──
// NOTE: all visuals live on plain <View>s — style callbacks on <Pressable>
// (style={({pressed}) => ...}) are dropped in this app's render pipeline.
const MenuSectionLabel = ({ label, hint }) => (
  <View style={styles.menuSectionRow}>
    <Text style={styles.menuSectionLabel}>{label}</Text>
    {hint ? (
      <View style={styles.menuSectionHintPill}>
        <Text style={styles.menuSectionHintText}>{hint}</Text>
      </View>
    ) : null}
  </View>
);

const MenuModeTile = ({ icon: Icon, label, description, active, onPress }) => (
  <Pressable onPress={onPress} accessibilityRole="button" accessibilityState={{ selected: !!active }}>
    <View style={[styles.menuModeTile, active && styles.menuModeTileOn]}>
      <View style={styles.menuModeTileTop}>
        <View style={[styles.menuIconChip, active && styles.menuIconChipOn]}>
          <Icon color={active ? COLORS.accentText : COLORS.textMuted} size={16} strokeWidth={2.3} />
        </View>
        {active ? (
          <View style={styles.menuTileCheck}>
            <Check color={COLORS.accentText} size={10} strokeWidth={3.6} />
          </View>
        ) : null}
      </View>
      <Text numberOfLines={1} style={[styles.menuModeTitle, active && styles.menuModeTitleOn]}>{label}</Text>
      <Text numberOfLines={1} style={styles.menuModeDesc}>{description}</Text>
    </View>
  </Pressable>
);

const MenuLayerTile = ({ icon: Icon, label, checked, onPress }) => (
  <Pressable onPress={onPress} accessibilityRole="switch" accessibilityState={{ checked: !!checked }}>
    <View style={[styles.menuLayerTile, checked && styles.menuLayerTileOn]}>
      <View style={[styles.menuIconChip, styles.menuIconChipSmall, checked && styles.menuIconChipOn]}>
        <Icon color={checked ? COLORS.accentText : COLORS.textDim} size={15} strokeWidth={2.3} />
      </View>
      <Text numberOfLines={1} style={[styles.menuLayerLabel, checked && styles.menuLayerLabelOn]}>{label}</Text>
    </View>
  </Pressable>
);

const MenuSegmentPill = ({ label, checked, onPress }) => (
  <Pressable onPress={onPress} accessibilityRole="switch" accessibilityState={{ checked: !!checked }}>
    <View style={[styles.menuSegPill, checked && styles.menuSegPillOn]}>
      <View style={[styles.menuSegDot, checked && styles.menuSegDotOn]} />
      <Text numberOfLines={1} style={[styles.menuSegLabel, checked && styles.menuSegLabelOn]}>{label}</Text>
    </View>
  </Pressable>
);

const MapToolChip = ({ icon: Icon, label, active, onPress, accessibilityLabel }) => (
  <Pressable
    onPress={onPress}
    accessibilityLabel={accessibilityLabel ?? label}
    accessibilityRole="button"
    accessibilityState={{ selected: !!active }}
  >
    <View style={[styles.mapToolChip, active && styles.mapToolChipOn]}>
      <View style={[styles.mapToolChipIcon, active && styles.mapToolChipIconOn]}>
        <Icon
          color={active ? COLORS.accentText : COLORS.accentBrand}
          size={15}
          strokeWidth={2.3}
        />
      </View>
      <Text style={[styles.mapToolChipLabel, active && styles.mapToolChipLabelOn]}>{label}</Text>
    </View>
  </Pressable>
);

const StatTile = ({ icon: Icon, label, value, tone = COLORS.textMain, accent = COLORS.accentBrand, wide = false }) => (
  <View style={[styles.statTile, wide && styles.statTileWide]}>
    <View style={styles.statTileTop}>
      <View style={[styles.statTileIcon, { backgroundColor: iconTintFor(accent) }]}>
        <Icon color={accent} size={13} strokeWidth={2.2} />
      </View>
      <Text style={styles.statTileLabel}>{label}</Text>
    </View>
    <Text style={[styles.statTileValue, { color: tone }]} numberOfLines={1}>{value}</Text>
  </View>
);

const StatusPill = ({ label, tone = COLORS.accentBrand, pulse = false }) => (
  <View style={[styles.statusPill, { backgroundColor: pillBgFor(tone), borderColor: pillBorderFor(tone) }]}>
    {pulse && <View style={[styles.statusPillDot, { backgroundColor: tone }]} />}
    <Text style={[styles.statusPillText, { color: tone }]}>{label}</Text>
  </View>
);

const TelemetryBlock = ({ title, icon: Icon, children, accent }) => (
  <View style={[styles.telemetryBlock, accent && styles.telemetryBlockAccent]}>
    <View style={styles.telemetryBlockHeader}>
      {Icon ? <Icon color={accent ? COLORS.accentBrand : COLORS.textDim} size={12} strokeWidth={2.4} /> : null}
      <Text style={styles.telemetryBlockTitle}>{title}</Text>
    </View>
    {children}
  </View>
);

const CoordRow = ({ label, value }) => (
  <View style={styles.coordRow}>
    <Text style={styles.coordLabel}>{label}</Text>
    <Text style={styles.coordValue} numberOfLines={1}>{value}</Text>
  </View>
);

const QuickChip = ({ icon: Icon, label, value, tone = COLORS.textMain }) => (
  <View style={styles.quickChip}>
    <Icon color={tone} size={12} strokeWidth={2.2} />
    <Text style={styles.quickChipLabel}>{label}</Text>
    <Text style={[styles.quickChipValue, { color: tone }]} numberOfLines={1}>{value}</Text>
  </View>
);

const normalizeVehicleMode = (raw) => {
  const upper = (raw || "MANUAL").toUpperCase();
  if (upper === "AUTO" || upper === "MISSION") return "OFFBOARD";
  return upper;
};

const VehicleModePill = ({ mode, onPress }) => {
  const isManual = mode === "MANUAL";
  const isOffboard = mode === "OFFBOARD";
  const isOther = !isManual && !isOffboard;
  const Icon = isManual ? Gamepad2 : isOffboard ? Hexagon : Zap;

  const pillStyle = isOffboard
    ? styles.pillActiveBrand
    : isOther
      ? styles.pillActiveWarn
      : styles.pillManualIdle;

  const iconColor = isOffboard
    ? COLORS.accentText
    : isOther
      ? COLORS.warning
      : COLORS.textMuted;

  const textStyle = isOffboard
    ? styles.pillTextActive
    : isOther
      ? styles.pillTextWarn
      : styles.pillTextIdle;

  return (
    <Pressable
      style={[styles.pillButton, pillStyle, isManual && styles.pillButtonDisabled]}
      onPress={onPress}
      disabled={isManual}
    >
      <Icon
        color={iconColor}
        size={16}
        strokeWidth={2.2}
        fill={isOffboard ? COLORS.accentText : "transparent"}
      />
      <Text style={[styles.pillText, textStyle]}>{mode}</Text>
      {isOffboard ? (
        <View style={styles.pillOnBadge}>
          <Text style={styles.pillOnBadgeText}>ON</Text>
        </View>
      ) : null}
      {isManual ? (
        <View style={styles.pillReadyBadge}>
          <Text style={styles.pillReadyBadgeText}>READY</Text>
        </View>
      ) : null}
      {isOther ? (
        <View style={styles.pillTapBadge}>
          <Text style={styles.pillTapBadgeText}>→ MANUAL</Text>
        </View>
      ) : null}
    </Pressable>
  );
};

const TopBarTogglePill = ({ icon: Icon, label, active, onPress, iconFill }) => (
  <Pressable
    style={[styles.pillButton, active ? styles.pillActiveBrand : styles.pillInactive]}
    onPress={onPress}
  >
    <Icon
      color={active ? COLORS.accentText : COLORS.textMuted}
      size={16}
      strokeWidth={2.2}
      fill={active ? iconFill : "transparent"}
    />
    <Text style={[styles.pillText, active ? styles.pillTextActive : styles.pillTextIdle]}>
      {label}
    </Text>
    {active ? (
      <View style={styles.pillOnBadge}>
        <Text style={styles.pillOnBadgeText}>ON</Text>
      </View>
    ) : null}
  </Pressable>
);

const RtkStreamPill = ({ mode, streaming, healthy, onPress }) => {
  const tone = streaming ? (healthy ? COLORS.success : COLORS.warning) : COLORS.textMuted;
  const barLevels = streaming ? (healthy ? [1, 1, 1, 1] : [1, 1, 0.35, 0.2]) : [0.2, 0.2, 0.2, 0.2];
  const barHeights = [4, 7, 10, 12];
  const statusLine = streaming
    ? (healthy ? "Live corrections" : "Weak stream")
    : "Tap to connect";

  return (
    <Pressable
      style={[styles.rtkPill, streaming && styles.rtkPillActive, streaming && !healthy && styles.rtkPillWarn]}
      onPress={onPress}
    >
      <View style={styles.rtkBars}>
        {barHeights.map((h, i) => (
          <View
            key={i}
            style={[
              styles.rtkBar,
              {
                height: h,
                backgroundColor: tone,
                opacity: barLevels[i],
              },
            ]}
          />
        ))}
      </View>
      <View style={styles.rtkPillCopy}>
        <Text style={[styles.rtkPillMode, streaming && { color: COLORS.textMain }]}>
          RTK {mode}
        </Text>
        <View style={styles.rtkPillStatusRow}>
          {streaming ? <View style={[styles.rtkLiveDot, { backgroundColor: tone }]} /> : null}
          <Text style={[styles.rtkPillStatus, { color: streaming ? tone : COLORS.textDim }]}>
            {statusLine}
          </Text>
        </View>
      </View>
    </Pressable>
  );
};

const NAV_ICON_SIZE = 44;
const NAV_PAD_H = 14;
const NAV_WIDTH_COLLAPSED = NAV_PAD_H * 2 + NAV_ICON_SIZE;
const NAV_WIDTH_EXPANDED = 252;
const NAV_WIDTH_COMPACT = 56;

const NAV_HEIGHT_COMPACT = 56;
const DOUBLE_TAP_MS = 320;
const HUD_PAD = 20;
const TOP_BAR_ITEM_HEIGHT = 40;
const RIGHT_PANEL_WIDTH = 340;
const SIDE_GAP = 14;

const MISSION_PANEL_HEIGHT_SHARE = 0.55; // mission gets 55% of usable rail height, telemetry the remaining 45%
const NAV_TIMING = { duration: 420, easing: Easing.bezier(0.4, 0, 0.2, 1) };
const PANEL_TIMING = { duration: 260, easing: Easing.bezier(0.4, 0, 0.2, 1) };
const QUICK_ACCESS_ANCHOR_FALLBACK = { top: HUD_PAD + 96, height: 58 };
const QUICK_ACCESS_SUBNAV_OFFSET = 24;
const SCREEN_WIDTH = Dimensions.get("window").width;
const SCREEN_HEIGHT = Dimensions.get("window").height;
const PANEL_SLIDE_IN = new Keyframe({
  0: { opacity: 1, transform: [{ translateX: 44 }] },
  100: { opacity: 1, transform: [{ translateX: 0 }] },
}).duration(PANEL_TIMING.duration);
const NAV_HEIGHT_FULL = SCREEN_HEIGHT - HUD_PAD * 2 - 55;
const ESTOP_SIZE = 96;
const ESTOP_RING_GAP = 4;
const ESTOP_RING_STROKE = 5;
const ESTOP_RING_RADIUS = ESTOP_SIZE / 2 + ESTOP_RING_GAP + ESTOP_RING_STROKE / 2;
const ESTOP_RING_SIZE = (ESTOP_RING_RADIUS + ESTOP_RING_STROKE / 2) * 2;
const ESTOP_RING_CIRC = 2 * Math.PI * ESTOP_RING_RADIUS;
const ESTOP_HOLD_MS = 1500;
const ESTOP_DRAG_THRESHOLD = 14;
const ESTOP_HUD_W = SCREEN_WIDTH - HUD_PAD * 2;
const ESTOP_HUD_H = SCREEN_HEIGHT - HUD_PAD * 2;
const ESTOP_INIT_X = (ESTOP_HUD_W - ESTOP_RING_SIZE) / 2;
const ESTOP_INIT_Y = ESTOP_HUD_H - ESTOP_RING_SIZE - 36;

const AnimatedSvgCircle = AnimatedReanimated.createAnimatedComponent(SvgCircle);


const MissionActionBtn = ({
  icon: Icon,
  label,
  onPress,
  variant = "secondary",
  fullWidth = false,
  big = false,
  disabled = false,
}) => {
  const isPrimary = variant === "primary";
  const isDanger = variant === "danger";
  const isWarning = variant === "warning";
  return (
    <Pressable
      disabled={disabled}
      style={[
        styles.missionActionBtn,
        fullWidth ? styles.missionActionFull : { flex: 1 },
        big && styles.missionActionBig,
        isPrimary && styles.missionActionPrimary,
        isDanger && styles.missionActionDanger,
        isWarning && styles.missionActionWarning,
        !isPrimary && !isDanger && !isWarning && styles.missionActionSecondary,
        disabled && { opacity: 0.55 },
      ]}
      onPress={onPress}
    >
      <View style={[
        styles.missionActionIconWrap,
        big && styles.missionActionIconWrapBig,
        isPrimary && { backgroundColor: COLORS.accentText + "1f" },
        isDanger && { backgroundColor: COLORS.pillSecondary },
        !isPrimary && !isDanger && { backgroundColor: COLORS.surfaceSolid },
      ]}>
        <Icon color={isPrimary ? COLORS.accentText : "#fff"} size={big ? 20 : 16} strokeWidth={2.2} />
      </View>
      <Text style={[styles.missionActionLabel, big && styles.missionActionLabelBig, isPrimary && styles.missionActionLabelDark]} numberOfLines={1}>{label}</Text>
    </Pressable>
  );
};

const FloatingEStop = ({ visible, onTrigger }) => {
  const posX = useSharedValue(ESTOP_INIT_X);
  const posY = useSharedValue(ESTOP_INIT_Y);
  const dragOriginX = useSharedValue(ESTOP_INIT_X);
  const dragOriginY = useSharedValue(ESTOP_INIT_Y);
  const scale = useSharedValue(1);
  const isDragging = useSharedValue(false);
  const tapPulse = useSharedValue(0);

  const clampEStop = (x, y) => {
    "worklet";
    const maxX = ESTOP_HUD_W - ESTOP_RING_SIZE;
    const maxY = ESTOP_HUD_H - ESTOP_RING_SIZE;
    return {
      x: Math.min(maxX, Math.max(0, x)),
      y: Math.min(maxY, Math.max(0, y)),
    };
  };

  const triggerEStop = useCallback(() => {
    onTrigger();
  }, [onTrigger]);

  const doubleTapGesture = Gesture.Tap()
    .numberOfTaps(2)
    .maxDelay(260)
    .onEnd((_event, success) => {
      if (success) {
        runOnJS(triggerEStop)();
      }
    });

  const panGesture = Gesture.Pan()
    .minDistance(ESTOP_DRAG_THRESHOLD)
    .onStart(() => {
      dragOriginX.value = posX.value;
      dragOriginY.value = posY.value;
    })
    .onUpdate((event) => {
      const next = clampEStop(
        dragOriginX.value + event.translationX,
        dragOriginY.value + event.translationY
      );
      posX.value = next.x;
      posY.value = next.y;
    })
    .onEnd(() => {
      const next = clampEStop(posX.value, posY.value);
      posX.value = next.x;
      posY.value = next.y;
      dragOriginX.value = next.x;
      dragOriginY.value = next.y;
    });

  const composedGesture = Gesture.Exclusive(doubleTapGesture, panGesture);

  const containerStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: posX.value },
      { translateY: posY.value },
      { scale: scale.value },
    ],
  }));

  if (!visible) return null;

  return (
    <View style={styles.estopLayer} pointerEvents="box-none">
      <GestureDetector gesture={composedGesture}>
        <AnimatedReanimated.View style={[styles.estopDraggable, containerStyle]}>
          <View style={styles.estopButton}>
            <ShieldAlert size={32} color="#fff" strokeWidth={2.5} />
            <Text style={styles.estopText}>E-STOP</Text>
            <Text style={styles.estopSubText}>2 TAP</Text>
          </View>
        </AnimatedReanimated.View>
      </GestureDetector>
    </View>
  );
};

const QuickSubNavSectionLabel = ({ label }) => (
  <Text style={styles.quickSubNavSectionLabel}>{label}</Text>
);

const QuickSubNavDivider = () => <View style={styles.quickSubNavDivider} />;

const QuickSubNavItem = ({
  icon: Icon,
  label,
  active,
  onPress,
  signal = false,
  healthy = false,
  danger = false,
  disabled = false,
  compact = false,
}) => (
  <Pressable
    style={[
      styles.quickSubNavItem,
      compact && styles.quickSubNavItemCompact,
      active && !danger && styles.quickSubNavItemActive,
      active && danger && styles.quickSubNavItemDangerActive,
      danger && !active && styles.quickSubNavItemDanger,
      disabled && styles.quickSubNavItemDisabled,
    ]}
    onPress={onPress}
    disabled={disabled}
  >
    <View style={[
      styles.quickSubNavIconWrap,
      compact && styles.quickSubNavIconWrapCompact,
      active && !danger && styles.quickSubNavIconWrapActive,
      active && danger && styles.quickSubNavIconWrapDangerActive,
      danger && !active && styles.quickSubNavIconWrapDanger,
    ]}>
      <Icon
        color={active ? (danger ? "#fff" : COLORS.accentText) : danger ? COLORS.danger : COLORS.textMuted}
        size={compact ? 16 : 18}
        strokeWidth={2.2}
      />
    </View>
    <View style={styles.quickSubNavItemBody}>
      <Text
        style={[
          styles.quickSubNavLabel,
          compact && styles.quickSubNavLabelCompact,
          active && !danger && styles.quickSubNavLabelActive,
          danger && styles.quickSubNavLabelDanger,
          disabled && styles.quickSubNavLabelDisabled,
        ]}
        numberOfLines={1}
      >
        {label}
      </Text>
      {signal ? (
        <View style={styles.quickSubNavSignalBars}>
          {[4, 7, 10, 12].map((h, i) => {
            const barActive = active && (healthy ? true : i < 2);
            return (
              <View
                key={i}
                style={{
                  width: 2.5,
                  height: h,
                  borderRadius: 1,
                  backgroundColor: barActive
                    ? healthy
                      ? COLORS.success
                      : COLORS.warning
                    : COLORS.textMuted,
                  opacity: barActive ? 1 : 0.3,
                }}
              />
            );
          })}
        </View>
      ) : null}
    </View>
  </Pressable>
);

const MAPBOX_STYLES = [
  "mapbox://styles/mapbox/satellite-streets-v12",
  "mapbox://styles/mapbox/satellite-v9",
  "mapbox://styles/mapbox/streets-v12",
  "mapbox://styles/mapbox/outdoors-v12",
  "mapbox://styles/mapbox/light-v11",
  "mapbox://styles/mapbox/dark-v11",
  "mapbox://styles/mapbox/navigation-day-v1",
  "mapbox://styles/mapbox/navigation-night-v1",
  "mapbox://styles/mapbox/standard"
];

export default function ModernHomeUI(props) {
  const {
    lines = [], importedPlan, systemHealth, telemetrySnapshot, missionRunning,
    onNav, onToggleMenu, onArmVehicle, onSetMode, onEstopVehicle,
    onStartPlan, onStopPlan, onClearMission, rtkStatus: rtkStatusProp = EMPTY_RTK_STATUS,
    rtkConnecting = false, startLora, selectedLineId, onSelectLine,
    autoOriginEnabled, mapSourceLines, alignedRefPoints, autoOriginReference,
    mapGeometryFrame, visualAlignmentItem, isVisualAlignmentMode,
    isPlanEditingMode,
    layerVisibility, setLayerVisibility, extensionsEnabled,
    virtualJoystick, onPausePlan, onResumePlan, isPaused = false, missionActionBusy = false,
    missionLoaded = false, missionLoadedPanelOpenToken = 0,
    mapViewEnabled = true, setMapViewEnabled, renderPlanPreview,
    csvMapPins = null, showRefPointLabels = false,
    onFocusRover, onFocusPlan,
    recenterRoverCount, recenterPlanCount,
    onResetNorth, resetNorthCount, autoOrigin, onToggleAutoOrigin,
    currentPage = "home",
    renderSectionContent,
    missionLayers = [],
    controlModeActive = false,
    canUseMissionControl = false,
    onToggleControlMode,
    onToggleMissionLayerVisibility,
    missionVisibleLines,
    missionVisibleMapSourceLines,
  } = props;

  const isHomePage = currentPage === "home";
  const rtkStatus = rtkStatusProp ?? EMPTY_RTK_STATUS;
  const rtkCorrectionsLive = hasLiveCorrections(rtkStatus);
  const rtkLifecycleLabel = rtkStatusLabel(rtkStatus);
  const canStartLora = !rtkStatus.running && rtkStatus.desired_mode === "idle";
  const isFieldsPage = currentPage === "fields";
  const PAGE_TO_NAV = {
    home: "main",
    fields: "fields",
    settings: "settings",
    howto: "howto",
  };

  // Local UI State
  const [mapStyleIndex, setMapStyleIndex] = useState(0);
  const [showTelemetry, setShowTelemetry] = useState(false);
  const [showMissionControl, setShowMissionControl] = useState(false);
  const [showJoystick, setShowJoystick] = useState(false);
  const [pendingJoystickOpen, setPendingJoystickOpen] = useState(false);
  const [quickAccessExpanded, setQuickAccessExpanded] = useState(false);
  const [mapFullscreen, setMapFullscreen] = useState(false);
  const [navExpanded, setNavExpanded] = useState(false);
  const [navIconsVisible, setNavIconsVisible] = useState(true);
  const [activeNav, setActiveNav] = useState(PAGE_TO_NAV[currentPage] || "main");
  const lastMenuTapRef = useRef(0);
  const lastNavTapRef = useRef({ id: null, time: 0 });
  const autoArmAttemptedRef = useRef(false);
  const autoAcquireAttemptedRef = useRef(false);
  const wasMissionControlOpenRef = useRef(false);
  const virtualJoystickRef = useRef(virtualJoystick);
  virtualJoystickRef.current = virtualJoystick;
  const hudLayerRef = useRef(null);
  const quickAccessAnchorRef = useRef(null);
  const [quickAccessAnchor, setQuickAccessAnchor] = useState(QUICK_ACCESS_ANCHOR_FALLBACK);
  const navWidth = useSharedValue(NAV_WIDTH_COLLAPSED);
  const navHeight = useSharedValue(NAV_HEIGHT_FULL);
  const navExpandProgress = useSharedValue(0);
  const navCompactProgress = useSharedValue(0);
  const quickAccessSubNavProgress = useSharedValue(0);
  const { height: windowHeight } = useWindowDimensions();
  // Usable rail height after the top gap, the gap between the two panels,
  // and the bottom gap (all HUD_PAD) are removed. Mission and telemetry
  // split this 55/45 so they always fill it exactly, with a fixed HUD_PAD
  // gap between them instead of whatever gap two independent ratios leave.
  const usableRailHeight = windowHeight - HUD_PAD * 3;
  // Mission Control is now content-sized (see missionPanelAuto), so Telemetry's
  // height is computed directly from its own share instead of "whatever's left
  // after Mission" — the two panels no longer need to be arithmetically coupled.
  const telemetryPanelHeight = Math.max(280, usableRailHeight * (1 - MISSION_PANEL_HEIGHT_SHARE));
  const [visualSelected, setVisualSelected] = useState(false);

  // ── Click to Mark & Manual Canvas Drawing state ──
  const [drawingMode, setDrawingMode] = useState<"none" | "click" | "manual">("none");
  const [showMarkMenu, setShowMarkMenu] = useState(false);
  const [drawnStrokes, setDrawnStrokes] = useState<{ lat: number; lon: number }[][]>([]);
  const [canvasStrokes, setCanvasStrokes] = useState<{ x: number; y: number }[][]>([]);
  const screenToGeoRef = useRef<((screen: { x: number; y: number }) => Promise<{ lat: number; lon: number } | null>) | null>(null);

  const drawnPoints = useMemo(() => {
    if (drawingMode === "manual") {
      return canvasStrokes.flat();
    }
    return drawnStrokes.flat();
  }, [drawingMode, canvasStrokes, drawnStrokes]);

  const [isUploadingDrawn, setIsUploadingDrawn] = useState(false);

  // ── Layers visibility filter (extension / rover / plan segment type) ──
  // Applies the same filter the SVG PlanPreview already honors to the native
  // Mapbox map, which otherwise never saw `layerVisibility` at all.
  const [showLayersMenu, setShowLayersMenu] = useState(false);
  const [showLayersPlanSubmenu, setShowLayersPlanSubmenu] = useState(false);
  // ── Control popover (mission-layer assignment + pills + Anchor) ──
  const [showControlMenu, setShowControlMenu] = useState(false);
  const showRoverMarker = layerVisibility?.rover !== false;
  const showRefPointsLayer = layerVisibility?.refPoints !== false;
  // Opt-in, unlike the flags around it: path length labels stay hidden until explicitly
  // enabled, so a dense plan reads as geometry rather than a wall of numbers.
  const showLengthLabels = layerVisibility?.lengths === true;
  // Prefer the backend-confirmed extensionsEnabled flag (authoritative, set from
  // extension_config.enabled on every path refresh) over inferring purely from
  // line tags — some renderer paths may not tag layer:"extension" precisely, but
  // this flag reflects the actual saved config regardless of how lines render.
  const hasExtensionLines = useMemo(
    () => Boolean(extensionsEnabled) || lines.some((line) => line.layer === "extension"),
    [lines, extensionsEnabled]
  );
  const availableSegmentKinds = useMemo(() => {
    const kinds = new Set();
    for (const line of lines) {
      if (line.layer === "extension" || line.layer === "transit" || line.layer === "virtual_boundary") continue;
      kinds.add(getPlanLineSegmentKind(line));
    }
    return Array.from(kinds).sort();
  }, [lines]);
  // Prefer mission-layer-filtered geometry for the Mapbox map when provided.
  const mapLinesForDisplay = missionVisibleLines ?? lines;
  const mapSourceForDisplay = missionVisibleMapSourceLines ?? mapSourceLines;
  const mapSourceLinesRaw = visualAlignmentItem
    ? []
    : autoOriginEnabled && mapSourceForDisplay
      ? mapSourceForDisplay
      : mapLinesForDisplay;
  const visibleMapLines = useMemo(
    () =>
      mapSourceLinesRaw.filter((line) => {
        if (line.layer === "extension") return layerVisibility?.extension !== false;
        return isSegmentKindVisible(line, layerVisibility?.segmentTypes);
      }),
    [mapSourceLinesRaw, layerVisibility]
  );

  const toggleLayerFlag = useCallback((key) => {
    setLayerVisibility?.((prev) => ({ ...(prev || {}), [key]: prev?.[key] === false ? true : false }));
  }, [setLayerVisibility]);

  /**
   * `lengths` is opt-in (hidden unless explicitly true), so it cannot use
   * `toggleLayerFlag`: that helper's `=== false ? true : false` assumes the default-visible
   * flags around it, and would map an unset value to `false` — a first tap that visibly
   * does nothing. Flip against the effective value instead, which is correct from unset,
   * false, or true alike.
   */
  const toggleLengthLabels = useCallback(() => {
    setLayerVisibility?.((prev) => ({ ...(prev || {}), lengths: !(prev?.lengths === true) }));
  }, [setLayerVisibility]);

  const toggleSegmentKind = useCallback((kind) => {
    setLayerVisibility?.((prev) => {
      const prevTypes = prev?.segmentTypes || {};
      return { ...(prev || {}), segmentTypes: { ...prevTypes, [kind]: prevTypes[kind] === false ? true : false } };
    });
  }, [setLayerVisibility]);

  const vehicleMode = normalizeVehicleMode(telemetrySnapshot?.mode ?? systemHealth?.mode);
  const isVehicleArmed = telemetrySnapshot?.armed ?? systemHealth?.armed ?? false;

  const batteryPct = telemetrySnapshot?.battery_pct ?? 0;
  const missionProgress = lines.length > 0 ? Math.min(100, Math.round(((telemetrySnapshot?.projection_segment_index || 0) / lines.length) * 100)) : 0;

  // Derived Telemetry Values
  const lat = telemetrySnapshot?.lat?.toFixed(8) ?? "N/A";
  const lon = telemetrySnapshot?.lon?.toFixed(8) ?? "N/A";
  // Prefer the human-readable fix name from API, fall back to numeric lookup
  const gpsFix = telemetrySnapshot?.gps_fix_name
    ?? (telemetrySnapshot?.gps_fix == null ? "No Fix"
      : telemetrySnapshot.gps_fix === 0 ? "No Fix"
      : telemetrySnapshot.gps_fix === 1 ? "No Fix"
      : telemetrySnapshot.gps_fix === 2 ? "2D Fix"
      : telemetrySnapshot.gps_fix === 3 ? "3D Fix"
      : telemetrySnapshot.gps_fix === 4 ? "DGPS"
      : telemetrySnapshot.gps_fix === 5 ? "RTK Float"
      : telemetrySnapshot.gps_fix === 6 ? "RTK Fixed"
      : `Fix ${telemetrySnapshot.gps_fix}`);
  const sats = telemetrySnapshot?.gps_sat ?? 0;
  // hrms/vrms displayed in centimetres (m * 100), 2 decimal places
  const hrms = telemetrySnapshot?.hrms != null ? (telemetrySnapshot.hrms * 100).toFixed(2) : "—";
  const vrms = telemetrySnapshot?.vrms != null ? (telemetrySnapshot.vrms * 100).toFixed(2) : "—";
  const missionStateStr = telemetrySnapshot?.mission_state ?? (missionRunning ? "running" : "idle");
  const xtrack = telemetrySnapshot?.xtrack_m != null ? telemetrySnapshot.xtrack_m.toFixed(2) : "—";
  const headingErr = telemetrySnapshot?.heading_err_deg != null ? telemetrySnapshot.heading_err_deg.toFixed(2) : "—";
  const headingDeg = telemetrySnapshot?.heading_ned_deg != null ? telemetrySnapshot.heading_ned_deg.toFixed(2) : "—";
  const roverHeadingDeg = telemetrySnapshot?.heading_ned_deg;
  const hasRoverHeading = roverHeadingDeg != null;
  const distGoal = telemetrySnapshot?.dist_to_goal_m != null ? telemetrySnapshot.dist_to_goal_m.toFixed(2) : "—";
  const speed = telemetrySnapshot?.speed_m_s != null ? telemetrySnapshot.speed_m_s.toFixed(2) : "—";
  const measuredSpeed = telemetrySnapshot?.measured_speed_m_s != null ? telemetrySnapshot.measured_speed_m_s.toFixed(2) : null;
  const displaySpeed = measuredSpeed ?? speed;
  const alongTrackSpeed = telemetrySnapshot?.along_track_speed_mps != null ? telemetrySnapshot.along_track_speed_mps.toFixed(2) : "—";
  const crossTrackSpeed = telemetrySnapshot?.cross_track_speed_mps != null ? telemetrySnapshot.cross_track_speed_mps.toFixed(2) : "—";
  const rppState = telemetrySnapshot?.rpp_state_name ?? "N/A";
  const fcuConn = systemHealth?.fcu_connected ? "Connected" : "Disconnected";
  const poseAge = telemetrySnapshot?.pose_age_ms != null ? telemetrySnapshot.pose_age_ms.toFixed(0) : "—";
  const battV = telemetrySnapshot?.battery_v != null ? telemetrySnapshot.battery_v.toFixed(2) : "—";
  // Ampere not explicitly in schema, show N/A
  const battA = "N/A";
  const joystickState = virtualJoystick?.state ?? "DISABLED";
  const hasJoystickLease = Boolean(virtualJoystick?.leaseId);
  const joystickActive = virtualJoystick?.joystickActive || telemetrySnapshot?.joystick_active;
  const stickEnabled =
    hasJoystickLease &&
    (joystickState === "ACTIVE" || joystickState === "HELD");
  const canAcquireJoystick = canAcquireJoystickForState({
    missionRunning,
    frontendState: joystickState,
    backendJoystickActive: telemetrySnapshot?.joystick_active,
    controlOwner: telemetrySnapshot?.control_owner,
  });

  const missionStateTone =
    missionStateStr === "running" ? COLORS.success
    : missionStateStr === "paused" ? COLORS.warning
    : missionStateStr === "error" ? COLORS.danger
    : COLORS.textMuted;

  const batteryTone =
    batteryPct > 50 ? COLORS.success
    : batteryPct > 20 ? COLORS.warning
    : COLORS.danger;

  const gpsFixTone =
    gpsFix.toLowerCase().includes("rtk") || gpsFix.toLowerCase().includes("fixed") ? COLORS.success
    : gpsFix.toLowerCase().includes("float") ? COLORS.warning
    : COLORS.danger;

  const joystickStateTone =
    joystickActive ? COLORS.success
    : hasJoystickLease ? COLORS.accentBrand
    : joystickState === "BLOCKED_BY_MISSION" ? COLORS.warning
    : COLORS.textMuted;

  useEffect(() => {
    if (!mapViewEnabled && mapFullscreen) setMapFullscreen(false);
  }, [mapViewEnabled, mapFullscreen]);

  useEffect(() => {
    if (!isHomePage && mapFullscreen) setMapFullscreen(false);
  }, [isHomePage, mapFullscreen]);

  const collapseNavbar = useCallback(() => {
    setNavExpanded(false);
    setQuickAccessExpanded(false);
  }, []);

  useEffect(() => {
    if (!navIconsVisible) setNavIconsVisible(true);
  }, [navIconsVisible]);

  useEffect(() => {
    const targetWidth = navExpanded ? NAV_WIDTH_EXPANDED : NAV_WIDTH_COLLAPSED;
    navWidth.value = withTiming(targetWidth, NAV_TIMING);
    navHeight.value = withTiming(NAV_HEIGHT_FULL, NAV_TIMING);
    navExpandProgress.value = withTiming(navExpanded ? 1 : 0, NAV_TIMING);
  }, [navExpanded, navWidth, navHeight, navExpandProgress]);

  useEffect(() => {
    setActiveNav(PAGE_TO_NAV[currentPage] || "main");
  }, [currentPage]);

  useEffect(() => {
    if (vehicleMode !== "MANUAL" || missionRunning) {
      setShowJoystick(false);
      if (missionRunning) setPendingJoystickOpen(false);
    }
  }, [vehicleMode, missionRunning]);

  useEffect(() => {
    if (!pendingJoystickOpen) return;
    if (vehicleMode === "MANUAL" && !missionRunning) {
      setShowJoystick(true);
      setPendingJoystickOpen(false);
    }
  }, [pendingJoystickOpen, vehicleMode, missionRunning]);

  useEffect(() => {
    if (missionLoadedPanelOpenToken <= 0) return;
    setShowTelemetry(true);
    setShowMissionControl(true);
    setShowJoystick(false);
    setPendingJoystickOpen(false);
    setQuickAccessExpanded(false);
  }, [missionLoadedPanelOpenToken]);

  useEffect(() => {
    const wasOpen = wasMissionControlOpenRef.current;
    wasMissionControlOpenRef.current = showMissionControl;

    if (wasOpen && !showMissionControl) {
      virtualJoystickRef.current?.release();
      setShowJoystick(false);
      setPendingJoystickOpen(false);
    }
  }, [showMissionControl]);

  useEffect(() => {
    if (!showJoystick) {
      autoArmAttemptedRef.current = false;
      autoAcquireAttemptedRef.current = false;
      return;
    }
    if (vehicleMode !== "MANUAL" || missionRunning || isVehicleArmed || missionActionBusy) return;
    if (autoArmAttemptedRef.current || !onArmVehicle) return;

    autoArmAttemptedRef.current = true;
    void onArmVehicle(true);
  }, [showJoystick, vehicleMode, missionRunning, isVehicleArmed, missionActionBusy, onArmVehicle]);

  useEffect(() => {
    if (!showJoystick || vehicleMode !== "MANUAL" || missionRunning || !isVehicleArmed) return;
    if (
      !canAcquireJoystick ||
      hasJoystickLease ||
      joystickState === "ACQUIRING" ||
      joystickState === "RELEASING"
    ) {
      return;
    }
    if (autoAcquireAttemptedRef.current || !virtualJoystick) return;

    autoAcquireAttemptedRef.current = true;
    virtualJoystick.acquire();
  }, [
    showJoystick,
    vehicleMode,
    missionRunning,
    isVehicleArmed,
    canAcquireJoystick,
    hasJoystickLease,
    joystickState,
    virtualJoystick,
  ]);

  useEffect(() => {
    quickAccessSubNavProgress.value = withTiming(quickAccessExpanded ? 1 : 0, PANEL_TIMING);
  }, [quickAccessExpanded, quickAccessSubNavProgress]);

  const updateQuickAccessAnchor = useCallback(() => {
    const hudNode = hudLayerRef.current;
    const anchorNode = quickAccessAnchorRef.current;
    if (!hudNode || !anchorNode) return;

    const applyPosition = (top, height) => {
      if (Number.isFinite(top) && Number.isFinite(height) && height > 0) {
        setQuickAccessAnchor({ top, height });
      }
    };

    if (typeof anchorNode.measureLayout === "function") {
      anchorNode.measureLayout(
        hudNode,
        (_x, y, _w, height) => applyPosition(y, height),
        () => {
          hudNode.measureInWindow((hx, hy) => {
            anchorNode.measureInWindow((_qx, qy, _qw, qh) => applyPosition(qy - hy, qh));
          });
        }
      );
      return;
    }

    hudNode.measureInWindow((hx, hy) => {
      anchorNode.measureInWindow((_qx, qy, _qw, qh) => applyPosition(qy - hy, qh));
    });
  }, []);

  useEffect(() => {
    if (!isHomePage || !navIconsVisible) return undefined;
    const frame = requestAnimationFrame(updateQuickAccessAnchor);
    const timer = setTimeout(updateQuickAccessAnchor, NAV_TIMING.duration + 40);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
    };
  }, [isHomePage, navIconsVisible, navExpanded, quickAccessExpanded, updateQuickAccessAnchor]);

  const navAnimatedStyle = useAnimatedStyle(() => ({
    width: navWidth.value,
    height: navHeight.value,
    paddingVertical: 12,
    paddingHorizontal: NAV_PAD_H,
    borderRadius: 22,
    backgroundColor: COLORS.navSolid,
    borderColor: COLORS.panelBorder,
  }));

  const compassAnimatedStyle = useAnimatedStyle(() => ({
    left: HUD_PAD + navWidth.value + SIDE_GAP,
    top: HUD_PAD,
  }));

  const quickAccessSubNavAnimatedStyle = useAnimatedStyle(() => ({
    left: HUD_PAD + navWidth.value - 1,
    opacity: quickAccessSubNavProgress.value,
    transform: [{ translateX: (1 - quickAccessSubNavProgress.value) * -10 }],
  }));

  const sectionContentAnimatedStyle = useAnimatedStyle(() => ({
    left: isFieldsPage ? 0 : HUD_PAD + navWidth.value + SIDE_GAP,
    right: isFieldsPage ? 0 : HUD_PAD,
    top: isFieldsPage ? 0 : HUD_PAD + SIDE_GAP,
    bottom: isFieldsPage ? 0 : HUD_PAD,
  }));

  const handleMenuPress = useCallback(() => {
    lastMenuTapRef.current = Date.now();
    setNavExpanded((v) => !v);
  }, []);

  const handleEStop = () => {
    if (onEstopVehicle) onEstopVehicle();
  };

  const handlePause = () => {
    if (onPausePlan) onPausePlan();
    else pauseMission(getApiBase()).catch(console.error);
  };

  const handleResume = () => {
    if (onResumePlan) onResumePlan();
  };

  const handleNext = () => {
    nextMission(getApiBase()).catch(console.error);
  };

  const handleExport = () => {
    exportLog(getApiBase()).catch(console.error);
  };

  const handleCloseManualPanel = useCallback(() => {
    virtualJoystickRef.current?.release();
    setShowJoystick(false);
    setPendingJoystickOpen(false);
  }, []);

  const manualDriveHint = stickEnabled
    ? "Move the stick to drive. Return to centre or lift finger to stop."
    : joystickState === "BLOCKED_BY_MISSION"
      ? "Mission active — stop mission before manual drive."
      : joystickState === "ACQUIRING"
        ? "Acquiring joystick control..."
        : hasJoystickLease
          ? "Lease held neutral — move the stick to drive."
          : joystickState === "SUSPENDED"
            ? "App resumed — close and reopen manual control."
            : !isVehicleArmed
              ? missionActionBusy
                ? "Arming vehicle..."
                : "Waiting for vehicle arm..."
              : "Preparing joystick control...";

  const openManualJoystickPanel = useCallback(() => {
    setShowMissionControl(true);
    setShowJoystick(true);
    setPendingJoystickOpen(true);
    setQuickAccessExpanded(false);
  }, []);

  const handleSetManualMode = useCallback(async () => {
    if (missionRunning) {
      Alert.alert("Mission Running", "Stop the mission before using manual drive.");
      return;
    }
    try {
      if (onSetMode) {
        await onSetMode("MANUAL");
      } else {
        const res = await fetch(`${getApiBase()}/api/set_mode`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode: "MANUAL" }),
        });
        if (!res.ok) throw new Error("Set mode failed");
      }
      openManualJoystickPanel();
    } catch {
      // setVehicleMode surfaces errors via alert/toast
    }
  }, [missionRunning, onSetMode, openManualJoystickPanel]);

  const handleStartLora = useCallback(() => {
    if (rtkConnecting || !canStartLora) return;
    if (startLora) startLora();
  }, [canStartLora, rtkConnecting, startLora]);

  const handleQuickAccessPress = useCallback(() => {
    setQuickAccessExpanded((v) => !v);
  }, []);

  const handleToggleMissionPanel = useCallback(() => {
    setShowMissionControl((v) => !v);
  }, []);

  const handleToggleTelemetryPanel = useCallback(() => {
    setShowTelemetry((v) => !v);
  }, []);

  // ── Click to Mark handlers ──
  const handleToggleMarkMenu = useCallback(() => {
    setShowMarkMenu((v) => !v);
    setShowControlMenu(false);
    setShowLayersMenu(false);
  }, []);

  const handleStartDrawingMode = useCallback((mode: "click" | "manual") => {
    setDrawingMode(mode);
    setDrawnStrokes([]);
    setCanvasStrokes([]);
    setShowMarkMenu(false);
  }, []);

  const handleMapClickToMark = useCallback((coord: { lat: number; lon: number }) => {
    if (drawingMode !== "click") return;
    setDrawnStrokes((prev) => [...prev, [coord]]);
  }, [drawingMode]);

  const handleUndoLastPoint = useCallback(() => {
    if (drawingMode === "manual") {
      setCanvasStrokes((prev) => prev.slice(0, -1));
    } else {
      setDrawnStrokes((prev) => prev.slice(0, -1));
    }
  }, [drawingMode]);

  const handleCancelDrawing = useCallback(() => {
    setDrawingMode("none");
    setDrawnStrokes([]);
    setCanvasStrokes([]);
  }, []);

  const handleFinishAndUpload = useCallback(async () => {
    let pointsToUpload: { lat: number; lon: number }[] = [];

    if (drawingMode === "manual") {
      if (canvasStrokes.length === 0) {
        Alert.alert("No Drawing", "Please draw a path on the canvas first.");
        return;
      }
      if (!screenToGeoRef.current) {
        Alert.alert("Error", "Map coordinate converter is not ready yet. Please try again.");
        return;
      }
      
      setIsUploadingDrawn(true);
      try {
        const converted: { lat: number; lon: number }[] = [];
        for (const stroke of canvasStrokes) {
          for (const pt of stroke) {
            const coord = await screenToGeoRef.current(pt);
            if (coord) {
              converted.push(coord);
            }
          }
        }
        if (converted.length === 0) {
          Alert.alert("Error", "Failed to resolve coordinates from the drawing.");
          setIsUploadingDrawn(false);
          return;
        }
        pointsToUpload = converted;
      } catch (err) {
        console.error("Coordinate conversion error:", err);
        Alert.alert("Error", "An error occurred during path conversion.");
        setIsUploadingDrawn(false);
        return;
      }
    } else {
      if (drawnPoints.length === 0) {
        Alert.alert("No Points", "Please tap the map to add at least one point.");
        return;
      }
      pointsToUpload = drawnPoints;
      setIsUploadingDrawn(true);
    }

    try {
      const apiBaseUrl = props.apiBaseUrl || getApiBase();

      // Generate a standard QGC WPL 110 format waypoints file.
      // This allows the backend to naturally handle GPS coordinates and convert them to a local cartesian path.
      let fileContent = "QGC WPL 110\n";
      for (let i = 0; i < pointsToUpload.length; i++) {
        const p = pointsToUpload[i];
        // format: <INDEX> <CURRENT_WP> <COORD_FRAME> <COMMAND> <PARAM1> <PARAM2> <PARAM3> <PARAM4> <LAT> <LON> <ALT> <AUTOCONTINUE>
        // COMMAND 16 is WAYPOINT.
        fileContent += `${i}\t${i === 0 ? 1 : 0}\t0\t16\t0\t0\t0\t0\t${p.lat}\t${p.lon}\t0\t1\n`;
      }

      // Create a Blob/FormData and upload
      const formData = new FormData();
      if (Platform.OS === "web") {
        const blob = new Blob([fileContent], { type: "text/plain" });
        formData.append("file", blob, "click_to_mark.waypoints");
      } else {
        // For React Native, write to a temp file first
        const FileSystem = require("expo-file-system/legacy");
        const tempUri = FileSystem.cacheDirectory + "click_to_mark.waypoints";
        await FileSystem.writeAsStringAsync(tempUri, fileContent, {
          encoding: "utf8",
        });
        formData.append("file", {
          uri: tempUri,
          name: "click_to_mark.waypoints",
          type: "text/plain",
        } as any);
      }

      const uploadRes = await pathApi.uploadPath(apiBaseUrl, formData);
      if (!uploadRes.ok) {
        const errText = await uploadRes.text();
        Alert.alert("Upload Error", errText || "Failed to upload the drawn path.");
        setIsUploadingDrawn(false);
        return;
      }

      // Success — set imported plan and navigate to fields page
      if (props.setImportedPlan) {
        props.setImportedPlan({
          fileName: "click_to_mark.waypoints",
          uri: "",
          fileType: "waypoints",
          source: "builtin",
        });
      }
      if (props.onSelectPath) {
        props.onSelectPath("click_to_mark.waypoints");
      }

      setDrawingMode("none");
      setDrawnStrokes([]);
      setCanvasStrokes([]);
      Alert.alert("Success", "Path uploaded! Redirecting to Fields page for alignment.", [
        {
          text: "OK",
          onPress: () => {
            onNav("fields");
          },
        },
      ]);
    } catch (err) {
      console.error("Drawing upload error:", err);
      Alert.alert("Error", "Could not upload the drawn path. Check connection.");
    } finally {
      setIsUploadingDrawn(false);
    }
  }, [drawingMode, drawnPoints, canvasStrokes, onNav, props.setImportedPlan, props.onSelectPath, props.apiBaseUrl]);

  const renderMapToolsColumn = () => {
    if ((!isHomePage && !isFieldsPage) || !navIconsVisible) return null;
    const layerTiles = [
      ...(hasExtensionLines
        ? [{
            key: "extension",
            icon: Spline,
            label: "Extension",
            checked: layerVisibility?.extension !== false,
            onPress: () => toggleLayerFlag("extension"),
          }]
        : []),
      { key: "rover", icon: Tractor, label: "Rover", checked: showRoverMarker, onPress: () => toggleLayerFlag("rover") },
      {
        key: "refPoints",
        icon: Crosshair,
        label: "Ref points",
        checked: layerVisibility?.refPoints !== false,
        onPress: () => toggleLayerFlag("refPoints"),
      },
      { key: "lengths", icon: Ruler, label: "Lengths", checked: showLengthLabels, onPress: toggleLengthLabels },
    ];
    return (
      <AnimatedReanimated.View style={[styles.mapToolsColumn, compassAnimatedStyle]} pointerEvents="box-none">
        <View style={styles.mapToolsGroupCard} pointerEvents="auto">
          <Pressable onPress={() => onResetNorth?.()} accessibilityLabel="Reset Map to North">
            <View style={styles.mapToolCompassWell}>
              <Compass
                headingDeg={roverHeadingDeg ?? 0}
                hasRoverHeading={hasRoverHeading}
                colors={COLORS}
                style={styles.topBarCompass}
                labelStyle={styles.topBarCompassLabel}
                labelIdleStyle={styles.topBarCompassLabelIdle}
              />
            </View>
          </Pressable>

          <View style={styles.mapToolsDivider} />

          <MapToolChip
            icon={MapIcon}
            label="Plan"
            onPress={() => onFocusPlan?.()}
            accessibilityLabel="Focus Plan"
          />

          <MapToolChip
            icon={Tractor}
            label="Rover"
            onPress={() => onFocusRover?.()}
            accessibilityLabel="Focus Rover"
          />

          {isHomePage && (
            <>
              <View style={styles.mapToolsDivider} />
              <View>
                <MapToolChip
                  icon={Pencil}
                  label="Mark"
                  active={drawingMode !== "none" || showMarkMenu}
                  onPress={handleToggleMarkMenu}
                  accessibilityLabel="Mark Options"
                />
                {showMarkMenu && (
                  <View style={[styles.menuPopover, styles.menuPopoverOptions]}>
                    <View style={styles.menuPopoverArrow} />

                    <MenuSectionLabel label="Draw Mode" hint={drawingMode !== "none" ? "Active" : null} />

                    <View style={styles.menuTileRow}>
                      <MenuModeTile
                        icon={MapPin}
                        label="Click to Waypoint"
                        description="Tap map to drop points"
                        active={drawingMode === "click"}
                        onPress={() => handleStartDrawingMode("click")}
                      />
                      <MenuModeTile
                        icon={Pencil}
                        label="Manual Drawing"
                        description="Freehand sketch"
                        active={drawingMode === "manual"}
                        onPress={() => handleStartDrawingMode("manual")}
                      />
                    </View>
                  </View>
                )}
              </View>
            </>
          )}

          {(isHomePage || isFieldsPage) && (
            <>
              <View style={styles.mapToolsDivider} />
              <View>
                <MapToolChip
                  icon={Layers}
                  label="Controls"
                  active={showControlMenu}
                  onPress={() => {
                    if (isHomePage) setShowMarkMenu(false);
                    setShowControlMenu((open) => {
                      const next = !open;
                      if (!next) {
                        setShowLayersMenu(false);
                        setShowLayersPlanSubmenu(false);
                      }
                      return next;
                    });
                  }}
                  accessibilityLabel="Controls"
                />

                {showControlMenu && (
                  <View
                    style={[
                      styles.menuPopover,
                      { width: menuPopoverWidthFor(Math.max(layerTiles.length, 1), MENU_LAYER_TILE_W) },
                    ]}
                  >
                    <View style={styles.menuPopoverArrow} />

                    <MenuSectionLabel label="Mission Control" />
                    <View style={styles.menuTileRow}>
                      <MenuLayerTile
                        icon={LayoutList}
                        label="Control mode"
                        checked={controlModeActive}
                        onPress={() => onToggleControlMode?.()}
                      />
                    </View>
                    {!canUseMissionControl ? (
                      <Text style={[styles.menuEmptyText, { marginTop: 4 }]}>
                        Finish aligning every uploaded file first.
                      </Text>
                    ) : null}

                    <View style={styles.menuDivider} />

                    <Pressable
                      onPress={() => {
                        setShowLayersMenu((v) => !v);
                        if (showLayersMenu) setShowLayersPlanSubmenu(false);
                      }}
                      accessibilityRole="button"
                      accessibilityLabel="Layers"
                      accessibilityState={{ expanded: showLayersMenu }}
                    >
                      <View style={styles.menuGroupHeader}>
                        <Layers color={COLORS.accentBrand} size={14} strokeWidth={2.3} />
                        <Text style={styles.menuGroupTitle}>Layers</Text>
                        <View style={styles.menuCountBadge}>
                          <Text style={styles.menuCountText}>
                            {layerTiles.filter((l) => l.checked).length}/{layerTiles.length}
                          </Text>
                        </View>
                        <ChevronRight
                          color={COLORS.textMuted}
                          size={13}
                          strokeWidth={2.6}
                          style={{ transform: [{ rotate: showLayersMenu ? "90deg" : "0deg" }] }}
                        />
                      </View>
                    </Pressable>

                    {showLayersMenu ? (
                      <>
                        <MenuSectionLabel
                          label="Map Layers"
                          hint={`${layerTiles.filter((l) => l.checked).length}/${layerTiles.length}`}
                        />
                        <View style={styles.menuTileRow}>
                          {layerTiles.map((tile) => (
                            <MenuLayerTile
                              key={tile.key}
                              icon={tile.icon}
                              label={tile.label}
                              checked={tile.checked}
                              onPress={tile.onPress}
                            />
                          ))}
                        </View>

                        <Pressable
                          onPress={() => setShowLayersPlanSubmenu((v) => !v)}
                          accessibilityRole="button"
                        >
                          <View style={styles.menuGroupHeader}>
                            <ChevronRight
                              color={COLORS.textMuted}
                              size={13}
                              strokeWidth={2.6}
                              style={{ transform: [{ rotate: showLayersPlanSubmenu ? "90deg" : "0deg" }] }}
                            />
                            <Text style={styles.menuGroupTitle}>Plan Segments</Text>
                            {availableSegmentKinds.length > 0 && (
                              <View style={styles.menuCountBadge}>
                                <Text style={styles.menuCountText}>
                                  {availableSegmentKinds.filter((k) => layerVisibility?.segmentTypes?.[k] !== false).length}/{availableSegmentKinds.length}
                                </Text>
                              </View>
                            )}
                          </View>
                        </Pressable>

                        {showLayersPlanSubmenu ? (
                          availableSegmentKinds.length === 0 ? (
                            <Text style={styles.menuEmptyText}>No plan loaded</Text>
                          ) : (
                            <View style={styles.menuSegRow}>
                              {availableSegmentKinds.map((kind) => (
                                <MenuSegmentPill
                                  key={kind}
                                  label={kind.charAt(0).toUpperCase() + kind.slice(1)}
                                  checked={layerVisibility?.segmentTypes?.[kind] !== false}
                                  onPress={() => toggleSegmentKind(kind)}
                                />
                              ))}
                            </View>
                          )
                        ) : null}
                      </>
                    ) : null}
                  </View>
                )}
              </View>
            </>
          )}
        </View>

        {/* Mission layer visibility pills — sit under the tool strip when layers exist.
            Same layer.visible state drives map preview AND Start execution. */}
        {(isHomePage || isFieldsPage) &&
        nonEmptyMissionLayers(missionLayers).length > 0 &&
        onToggleMissionLayerVisibility ? (
          <View style={{ marginTop: 8, alignSelf: "flex-start" }}>
            <MissionLayerPills layers={missionLayers} onToggle={onToggleMissionLayerVisibility} />
          </View>
        ) : null}
      </AnimatedReanimated.View>
    );
  };

  const renderQuickAccessSubNav = () => {
    if (!isHomePage || !navIconsVisible || !quickAccessExpanded) return null;
    return (
      <AnimatedReanimated.View
        style={[
          styles.quickAccessSubNav,
          quickAccessSubNavAnimatedStyle,
          { top: quickAccessAnchor.top + QUICK_ACCESS_SUBNAV_OFFSET },
        ]}
        pointerEvents="box-none"
      >
        <View style={styles.quickAccessSubNavInner} pointerEvents="auto">
          <View style={styles.quickAccessSubNavBridge} />
          <View style={styles.quickAccessSubNavRow}>
            <QuickSubNavSectionLabel label="Vehicle" />
            <QuickSubNavItem
              icon={vehicleMode === "MANUAL" ? Gamepad2 : vehicleMode === "OFFBOARD" ? Hexagon : Zap}
              label={vehicleMode || "MANUAL"}
              active={vehicleMode === "MANUAL"}
              onPress={handleSetManualMode}
            />

            <QuickSubNavDivider />
            <QuickSubNavSectionLabel label="RTK" />
            <QuickSubNavItem
              icon={rtkStatus.running ? Activity : RadioTower}
              label={rtkLifecycleLabel}
              active={rtkCorrectionsLive || (rtkStatus.mode === "lora" && rtkStatus.healthy)}
              danger={rtkStatus.source_state === "error" || rtkStatus.source_state === "unavailable"}
              signal
              healthy={rtkCorrectionsLive || (rtkStatus.mode === "lora" && rtkStatus.healthy)}
              disabled={rtkConnecting || rtkStatus.running}
              onPress={() => {
                // Backend owns NTRIP autostart. This is status-only when running
                // and opens backend profile management when idle/unavailable.
                if (rtkConnecting || rtkStatus.running) return;
                onNav?.("settings");
              }}
            />
            {canStartLora ? (
              <QuickSubNavItem
                icon={Radio}
                label="Start LoRa"
                disabled={rtkConnecting}
                onPress={handleStartLora}
              />
            ) : null}

            <QuickSubNavDivider />
            <QuickSubNavSectionLabel label="Panels" />
            <QuickSubNavItem
              icon={Route}
              label="Mission"
              active={showMissionControl}
              onPress={handleToggleMissionPanel}
            />
            <QuickSubNavItem
              icon={MonitorPlay}
              label="Telemetry"
              active={showTelemetry}
              onPress={handleToggleTelemetryPanel}
            />
          </View>
        </View>
      </AnimatedReanimated.View>
    );
  };

  const handleNavPress = (id) => {
    setActiveNav(id);
    if (id === "main") onNav("home");
    if (id === "settings") onNav("settings");
    if (id === "fields") onNav("fields");
    if (id === "howto") onNav("howto");
  };

  const handleNavItemPress = useCallback((id) => {
    lastNavTapRef.current = { id, time: Date.now() };
    handleNavPress(id);
  }, [onNav]);

  const onCycleMapStyle = useCallback(() => {
    setMapStyleIndex((prev) => (prev + 1) % MAPBOX_STYLES.length);
  }, []);

  const onExitSession = useCallback(() => {
    onNav("connection");
  }, [onNav]);

  const renderNavbar = () => (
    <Navbar
      navAnimatedStyle={navAnimatedStyle}
      navExpandProgress={navExpandProgress}
      navCompactProgress={navCompactProgress}
      navIconsVisible={navIconsVisible}
      navExpanded={navExpanded}
      isHomePage={isHomePage}
      activeNav={activeNav}
      quickAccessExpanded={quickAccessExpanded}
      quickAccessAnchorRef={quickAccessAnchorRef}
      handleMenuPress={handleMenuPress}
      handleQuickAccessPress={handleQuickAccessPress}
      handleNavItemPress={handleNavItemPress}
      updateQuickAccessAnchor={updateQuickAccessAnchor}
      onCycleMapStyle={onCycleMapStyle}
      onExitSession={onExitSession}
      colors={COLORS}
      styles={styles}
    />
  );

  const renderTelemetrySection = () => {
    if (!showTelemetry) return null;

    const battPctClamped = Math.min(100, Math.max(0, batteryPct));
    const fcuTone = systemHealth?.fcu_connected ? COLORS.success : COLORS.danger;

    return (
      <View
        pointerEvents="auto"
        style={[styles.rightPanelBase, styles.telemetryPanel, { height: telemetryPanelHeight, opacity: 1 }]}
      >
        <PanelHeader
          icon={Activity}
          title="Telemetry"
          subtitle="Real-time rover data"
          live
          onClose={() => setShowTelemetry(false)}
        />

        <View style={styles.telemetryQuickStrip}>
          <QuickChip icon={Satellite} label="Fix" value={gpsFix} tone={gpsFixTone} />
          <QuickChip icon={Radio} label="FCU" value={fcuConn} tone={fcuTone} />
          <QuickChip icon={Battery} label="Batt" value={`${batteryPct}%`} tone={batteryTone} />
        </View>

        <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.telemetryScroll} showsVerticalScrollIndicator={false}>
          <TelemetryBlock title="Position" icon={MapPin}>
            <View style={styles.coordCard}>
              <CoordRow label="LAT" value={lat} />
              <View style={styles.coordDivider} />
              <CoordRow label="LON" value={lon} />
            </View>
            <View style={styles.statGrid}>
              <StatTile icon={Satellite} label="Satellites" value={String(sats)} accent={COLORS.accentBrand} />
              <StatTile icon={Target} label="HRMS" value={hrms !== "—" ? `${hrms} cm` : "—"} accent={COLORS.textMuted} />
              <StatTile icon={Target} label="VRMS" value={vrms !== "—" ? `${vrms} cm` : "—"} accent={COLORS.textMuted} />
              <StatTile icon={Activity} label="Pose Age" value={poseAge !== "—" ? `${poseAge} ms` : "—"} accent={COLORS.textMuted} />
            </View>
          </TelemetryBlock>

          <TelemetryBlock title="Mission" icon={Route} accent>
            <View style={styles.telemetryMissionRow}>
              <View>
                <Text style={styles.telemetryMissionLabel}>Mission state</Text>
                <Text style={styles.telemetryMissionHint}>Live guidance metrics</Text>
              </View>
              <StatusPill label={missionStateStr.toUpperCase()} tone={missionStateTone} pulse={missionStateStr === "running"} />
            </View>
            <View style={styles.statGrid}>
              {/* X-Track from xtrack_m */}
              <StatTile
                icon={Route}
                label="X-Track"
                value={xtrack !== "—" ? `${xtrack} m` : "—"}
                accent={Math.abs(parseFloat(xtrack) || 0) > 0.05 ? COLORS.danger : COLORS.accentBrand}
              />
              {/* Heading error from heading_err_deg */}
              <StatTile
                icon={Navigation}
                label="Hdg Err"
                value={headingErr !== "—" ? `${headingErr}°` : "—"}
                accent={Math.abs(parseFloat(headingErr) || 0) > 10 ? COLORS.danger : COLORS.warning}
              />
              {/* Distance to goal from dist_to_goal_m */}
              <StatTile
                icon={Target}
                label="Dist Goal"
                value={distGoal !== "—" ? `${distGoal} m` : "—"}
                accent={COLORS.success}
              />
              {/* Speed — prefers measured_speed_m_s from MAVROS */}
              <StatTile
                icon={Gauge}
                label="Speed"
                value={displaySpeed !== "—" ? `${displaySpeed} m/s` : "—"}
                accent={COLORS.accentBrand}
              />
            </View>
            {/* Along/cross track speeds row */}
            <View style={[styles.statGrid, { marginTop: 6 }]}>
              <StatTile icon={Route} label="Along-Trk" value={alongTrackSpeed !== "—" ? `${alongTrackSpeed} m/s` : "—"} accent={COLORS.textMuted} />
              <StatTile icon={Route} label="Cross-Trk" value={crossTrackSpeed !== "—" ? `${crossTrackSpeed} m/s` : "—"} accent={COLORS.textMuted} />
            </View>
          </TelemetryBlock>

          <TelemetryBlock title="Systems" icon={Zap}>
            <View style={styles.systemsRow}>
              <View style={styles.systemsItem}>
                <Text style={styles.systemsLabel}>RPP</Text>
                <Text style={styles.systemsValue} numberOfLines={1}>{rppState}</Text>
              </View>
              <View style={styles.systemsDivider} />
              <View style={styles.systemsItem}>
                <Text style={styles.systemsLabel}>FCU</Text>
                <Text style={[styles.systemsValue, { color: fcuTone }]} numberOfLines={1}>{fcuConn}</Text>
              </View>
            </View>
          </TelemetryBlock>

          <TelemetryBlock title="Power" icon={Battery}>
            <View style={styles.batteryCard}>
              <View style={styles.batteryCardHeader}>
                <View style={[styles.batteryIconWrap, { backgroundColor: iconTintFor(batteryTone), borderColor: pillBorderFor(batteryTone) }]}>
                  <Battery color={batteryTone} size={16} strokeWidth={2.2} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.batteryCardTitle, { color: batteryTone }]}>{batteryPct}%</Text>
                  <Text style={styles.batteryCardSub}>{battV}V · {battA}A</Text>
                </View>
                <View style={[styles.batteryPctBadge, { backgroundColor: pillBgFor(batteryTone), borderColor: pillBorderFor(batteryTone) }]}>
                  <Text style={[styles.batteryPctBadgeText, { color: batteryTone }]}>
                    {batteryPct > 50 ? "OK" : batteryPct > 20 ? "LOW" : "CRIT"}
                  </Text>
                </View>
              </View>
              <View style={styles.batteryTrack}>
                <View style={[styles.batteryFill, { width: `${battPctClamped}%`, backgroundColor: batteryTone }]} />
              </View>
            </View>
          </TelemetryBlock>
        </ScrollView>
      </View>
    );
  };

  const renderJoystickPanel = () => {
    return null;
  };

  const renderMissionControl = () => {
    if (!showMissionControl) return null;

    const statusLabel = joystickActive
      ? "Driving"
      : hasJoystickLease
        ? "Lease active"
        : joystickState.replace(/_/g, " ").toLowerCase();

    return (
      <View
        pointerEvents="auto"
        style={[
          styles.rightPanelBase,
          styles.missionPanel,
          styles.missionPanelAuto,
          { opacity: 1 },
        ]}
      >
        <PanelHeader
          icon={showJoystick ? Gamepad2 : Route}
          title={showJoystick ? "Manual Control" : "Mission Control"}
          subtitle={
            showJoystick
              ? stickEnabled
                ? "Ready to drive"
                : joystickState === "ACQUIRING"
                  ? "Acquiring joystick..."
                  : hasJoystickLease
                    ? "Lease active — move stick"
                    : missionActionBusy
                      ? "Arming vehicle..."
                      : isVehicleArmed
                        ? "Preparing joystick..."
                        : "Preparing manual drive..."
              : missionRunning
                ? "Mission in progress"
                : "Ready to start"
          }
          live={missionRunning}
          onClose={!missionRunning ? () => {
            if (showJoystick) handleCloseManualPanel();
            else setShowMissionControl(false);
          } : undefined}
        />

        <View
          style={[styles.panelScrollContent, showJoystick && styles.joystickScrollContent]}
        >
          {showJoystick && vehicleMode === "MANUAL" && !missionRunning ? (
            <>
              <View style={styles.joystickCard}>
                <ManualJoystick
                  onChange={(vals) => {
                    if (virtualJoystick) virtualJoystick.setIntent(vals.forward, vals.yaw);
                  }}
                  onRelease={() => {
                    if (virtualJoystick) virtualJoystick.setIntent(0, 0);
                  }}
                  size={160}
                  knobSize={50}
                  disabled={!stickEnabled}
                />
                {!stickEnabled ? (
                  <View style={styles.joystickOverlay}>
                    <ShieldAlert color="#fff" size={18} strokeWidth={2} />
                    <Text style={styles.joystickOverlayText}>
                      {joystickState === "ACQUIRING"
                        ? "Acquiring..."
                        : isVehicleArmed
                          ? "Preparing drive..."
                          : missionActionBusy
                            ? "Arming..."
                            : "Waiting for arm..."}
                    </Text>
                  </View>
                ) : null}
              </View>

              {/* Throttle & Steering readout at bottom */}
              {virtualJoystick?.displayIntent ? (
                <View style={styles.joystickReadoutRow}>
                  <View style={styles.joystickReadoutItem}>
                    <Text style={styles.joystickReadoutLabel}>THROTTLE</Text>
                    <Text style={styles.joystickReadoutValue}>
                      {virtualJoystick.displayIntent.throttle >= 0 ? "+" : ""}
                      {virtualJoystick.displayIntent.throttle.toFixed(2)}
                    </Text>
                  </View>
                  <View style={styles.joystickReadoutDivider} />
                  <View style={styles.joystickReadoutItem}>
                    <Text style={styles.joystickReadoutLabel}>STEERING</Text>
                    <Text style={styles.joystickReadoutValue}>
                      {virtualJoystick.displayIntent.steering >= 0 ? "+" : ""}
                      {virtualJoystick.displayIntent.steering.toFixed(2)}
                    </Text>
                  </View>
                </View>
              ) : null}
            </>
          ) : (
            <>
              <View style={styles.progressCard}>
                <View style={styles.progressTopRow}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                    <Text style={styles.progressTitle}>Route Completed</Text>
                    <Text style={{ color: missionStateTone, fontSize: 11, fontWeight: "700", textTransform: "lowercase" }}>
                      • {missionStateStr || "idle"}
                    </Text>
                  </View>
                  <Text style={styles.progressPercent}>{missionProgress}%</Text>
                </View>
                <View style={styles.progressBarTrack}>
                  <View style={[styles.progressBarFill, { width: `${missionProgress}%` }]} />
                </View>
                <View style={styles.progressMetaRow}>
                  <View style={styles.progressMetaItem}>
                    <Text style={styles.progressMetaLabel}>X-Track</Text>
                    <Text style={styles.progressMetaValue}>{xtrack} m</Text>
                  </View>
                  <View style={styles.progressMetaDivider} />
                  <View style={styles.progressMetaItem}>
                    <Text style={styles.progressMetaLabel}>Speed</Text>
                    <Text style={styles.progressMetaValue}>{speed} m/s</Text>
                  </View>
                  <View style={styles.progressMetaDivider} />
                  <View style={styles.progressMetaItem}>
                    <Text style={styles.progressMetaLabel}>ETA</Text>
                    <Text style={styles.progressMetaValue}>--:--</Text>
                  </View>
                </View>
              </View>

              <View style={styles.missionActionsGrid}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 10, width: "100%" }}>
                  <View style={{ flex: 1 }}>
                    <MissionActionBtn
                      icon={missionRunning ? Square : Play}
                      label={
                        missionActionBusy
                          ? missionRunning
                            ? "Stopping…"
                            : "Starting…"
                          : missionRunning
                            ? "Stop Mission"
                            : "Start Mission"
                      }
                      variant={missionRunning ? "danger" : "primary"}
                      fullWidth
                      big
                      disabled={missionActionBusy}
                      onPress={missionRunning ? onStopPlan : onStartPlan}
                    />
                  </View>
                  {!missionRunning ? (
                    <Pressable
                      onPress={onToggleAutoOrigin}
                      accessibilityLabel="Auto Origin Checkbox"
                      style={{
                        width: 48,
                        height: 48,
                        borderRadius: 12,
                        backgroundColor: autoOrigin ? "rgba(16, 185, 129, 0.15)" : COLORS.surfaceSolid,
                        borderWidth: 1.5,
                        borderColor: autoOrigin ? "#10b981" : COLORS.panelBorder,
                        justifyContent: "center",
                        alignItems: "center",
                      }}
                    >
                      {autoOrigin ? <Check color="#10b981" size={22} strokeWidth={3} /> : null}
                    </Pressable>
                  ) : null}
                </View>
                {isPaused ? (
                  <MissionActionBtn
                    icon={Play}
                    label="Resume"
                    variant="primary"
                    fullWidth
                    big
                    onPress={handleResume}
                  />
                ) : (
                  <MissionActionBtn
                    icon={Pause}
                    label="Pause"
                    variant="warning"
                    fullWidth
                    big
                    onPress={handlePause}
                  />
                )}
                <View style={styles.missionSubActionsRow}>
                  <MissionActionBtn icon={SkipForward} label="Next" onPress={handleNext} />
                  <MissionActionBtn icon={Download} label="Export Log" onPress={handleExport} />
                  {vehicleMode === "MANUAL" && !missionRunning ? (
                    <MissionActionBtn icon={Gamepad2} label="Joystick" onPress={() => setShowJoystick(true)} />
                  ) : null}
                </View>
              </View>
            </>
          )}
        </View>
      </View>
    );
  };

  const hudVisible = !mapFullscreen;

  return (
    <View style={styles.container}>
      {/* Home map only. Fields hosts its own PlanPreview MapView — a transparent
          full-screen Fields overlay hides native Mapbox on Android. */}
      {isHomePage ? (
      <View style={{ ...StyleSheet.absoluteFillObject, zIndex: mapFullscreen ? 200 : 1, backgroundColor: COLORS.bgBase }}>
        {mapViewEnabled ? (
          <>
            <MapView
              styleURL={MAPBOX_STYLES[mapStyleIndex]}
              mode={visualAlignmentItem ? "templates" : "fields"}
              placedItems={visualAlignmentItem ? [visualAlignmentItem] : []}
              selectedItemIds={visualAlignmentItem && visualSelected ? [visualAlignmentItem.id] : []}
              // Plan sticker modes: rotate+pan only — never pinch-scale to fake a second ref fit.
              multiTouchMode={visualAlignmentItem ? "rotate" : "both"}
              onSelectionChange={(ids) => {
                if (isVisualAlignmentMode || isPlanEditingMode) {
                  setVisualSelected(visualAlignmentItem ? ids.includes(visualAlignmentItem.id) : false);
                }
              }}
              onUpdatePlacedItem={(id, updates) => {
                if (!(isVisualAlignmentMode || isPlanEditingMode)) return;
                if (visualAlignmentItem && id !== visualAlignmentItem.id) return;
                if (props.setVisualAlignmentItem) {
                  props.setVisualAlignmentItem((prev) => {
                    if (!prev) return prev;
                    return { ...prev, ...updates };
                  });
                }
              }}
              telemetrySnapshot={telemetrySnapshot}
              lines={visibleMapLines}
              showRover={showRoverMarker}
              showLengths={showLengthLabels}
              alignedRefPoints={alignedRefPoints}
              autoOriginReference={autoOriginReference}
              mapGeometryFrame={mapGeometryFrame}
              autoOriginEnabled={autoOriginEnabled}
              stagedVerified={false}
              // Keep plan projection stable after Fix Alignment / plan-edit (same anchor as Fields).
              visualAlignmentAnchor={props.visualAlignmentAnchor ?? null}
              visible={mapViewEnabled}
              recenterRoverTrigger={recenterRoverCount}
              recenterPlanTrigger={recenterPlanCount}
              resetNorthTrigger={resetNorthCount}
              onSelectPoint={props.onSelectPoint}
              onSelectLine={onSelectLine}
              selectedLineId={selectedLineId}
              selectedPoints={showRefPointsLayer ? csvMapPins ?? undefined : undefined}
              showRefPointLabels={showRefPointsLayer && showRefPointLabels}
              onMapClickToMark={drawingMode === "click" ? handleMapClickToMark : undefined}
              drawnWaypoints={drawingMode !== "none" ? drawnPoints : undefined}
              manualDrawingEnabled={drawingMode === "manual"}
              screenToGeoRef={screenToGeoRef}
            />
            {drawingMode === "manual" && (
              <FreehandCanvasOverlay
                canvasStrokes={canvasStrokes}
                onStrokeFinished={(stroke) => {
                  setCanvasStrokes((prev) => [...prev, stroke]);
                }}
                COLORS={COLORS}
              />
            )}
          </>
        ) : renderPlanPreview ? (
          <View style={styles.canvasContainer}>
            {renderPlanPreview()}
          </View>
        ) : (
          <View style={styles.mapOffPlaceholder}>
            <MapIcon color={COLORS.textMuted} size={32} strokeWidth={1.5} />
            <Text style={styles.mapOffTitle}>Map Off</Text>
            <Text style={styles.mapOffSub}>Use Map On in the navbar to enable</Text>
          </View>
        )}


      </View>
      ) : (
        <View style={{ ...StyleSheet.absoluteFillObject, zIndex: 1, backgroundColor: COLORS.bgBase }} />
      )}

      {!isHomePage && renderSectionContent ? (
        <AnimatedReanimated.View
          style={[styles.sectionContent, sectionContentAnimatedStyle, isFieldsPage && StyleSheet.absoluteFillObject]}
          pointerEvents="box-none"
        >
          <AppErrorBoundary name={currentPage || "page"}>
            {renderSectionContent()}
          </AppErrorBoundary>
        </AnimatedReanimated.View>
      ) : null}
      
      {/* HUD Layer */}
      {hudVisible ? (
        <View ref={hudLayerRef} style={styles.hudLayer} pointerEvents="box-none" collapsable={false}>
          {renderNavbar()}
          {renderQuickAccessSubNav()}
          {renderMapToolsColumn()}
          {isHomePage ? (
            <View style={styles.rightPanelRail} pointerEvents="box-none">
              {renderTelemetrySection()}
              {renderMissionControl()}
            </View>
          ) : null}
          {isHomePage ? <FloatingEStop visible={missionRunning || isVehicleArmed} onTrigger={handleEStop} /> : null}

          {/* Drawing floating toolbar */}
          {drawingMode !== "none" && (
            <View style={[styles.drawingToolbar, { bottom: 48 }]} pointerEvents="auto">
              <View style={styles.drawingToolbarInner}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                  <Pencil color={COLORS.accentBrand} size={16} strokeWidth={2.5} />
                  <Text style={{ color: COLORS.textMain, fontWeight: "700", fontSize: 13 }}>
                    {drawingMode === "click" ? "Click to Mark" : "Manual Drawing"}
                  </Text>
                  <View style={{
                    backgroundColor: COLORS.accentMuted,
                    borderRadius: 10,
                    paddingHorizontal: 8,
                    paddingVertical: 2,
                    borderWidth: 1,
                    borderColor: COLORS.accentBorder,
                  }}>
                    <Text style={{ color: COLORS.accentBrand, fontSize: 11, fontWeight: "800" }}>
                      {drawnPoints.length} {drawnPoints.length === 1 ? "point" : "points"}
                    </Text>
                  </View>
                </View>
                <Text style={{ color: COLORS.textDim, fontSize: 11, marginTop: 4 }}>
                  {drawingMode === "click" ? "Tap anywhere on the map to add waypoints" : "Draw freehand on the screen canvas"}
                </Text>
                <View style={{ flexDirection: "row", gap: 8, marginTop: 10 }}>
                  <Pressable
                    style={({ pressed }) => [styles.drawingBtn, styles.drawingBtnSecondary, pressed && { opacity: 0.7 }]}
                    onPress={handleUndoLastPoint}
                    disabled={drawnPoints.length === 0}
                  >
                    <Undo2 color={drawnPoints.length === 0 ? COLORS.textDim : COLORS.textMain} size={14} strokeWidth={2.2} />
                    <Text style={[styles.drawingBtnText, drawnPoints.length === 0 && { color: COLORS.textDim }]}>Undo</Text>
                  </Pressable>
                  <Pressable
                    style={({ pressed }) => [styles.drawingBtn, styles.drawingBtnDanger, pressed && { opacity: 0.7 }]}
                    onPress={handleCancelDrawing}
                  >
                    <X color={COLORS.danger} size={14} strokeWidth={2.5} />
                    <Text style={[styles.drawingBtnText, { color: COLORS.danger }]}>Cancel</Text>
                  </Pressable>
                  {drawnPoints.length > 0 && (
                    <Pressable
                      style={({ pressed }) => [
                        styles.drawingBtn,
                        styles.drawingBtnPrimary,
                        pressed && { opacity: 0.7 },
                        isUploadingDrawn && { opacity: 0.5 },
                      ]}
                      onPress={handleFinishAndUpload}
                      disabled={isUploadingDrawn}
                    >
                      <Check color="#ffffff" size={14} strokeWidth={2.5} />
                      <Text style={[styles.drawingBtnText, { color: "#ffffff" }]}>
                        {isUploadingDrawn ? "Uploading..." : "Finish & Upload"}
                      </Text>
                    </Pressable>
                  )}
                </View>
              </View>
            </View>
          )}
        </View>
      ) : null}

      {mapFullscreen ? (
        <Pressable
          style={styles.fullscreenCloseBtn}
          onPress={() => setMapFullscreen(false)}
          hitSlop={12}
        >
          <X color={COLORS.textMain} size={22} strokeWidth={2.4} />
        </Pressable>
      ) : null}

      {/* Plan Editing Rotation/Scale Overlay */}
      {isPlanEditingMode && visualAlignmentItem ? (
        <View style={{
          position: "absolute",
          top: 80,
          alignSelf: "center",
          zIndex: 300,
          backgroundColor: "rgba(0,0,0,0.85)",
          borderRadius: 14,
          paddingHorizontal: 20,
          paddingVertical: 12,
          borderWidth: 1,
          borderColor: COLORS.accentBrand,
          flexDirection: "row",
          gap: 18,
          alignItems: "center",
        }}>
          <View style={{ alignItems: "center" }}>
            <Text style={{ color: COLORS.textMuted, fontSize: 10, fontWeight: "700", letterSpacing: 0.5 }}>ROTATION</Text>
            <Text style={{ color: COLORS.accentBrand, fontSize: 22, fontWeight: "900", fontFamily: "monospace" }}>
              {(visualAlignmentItem.rotation ?? 0).toFixed(1)}°
            </Text>
          </View>
          <View style={{ width: 1, height: 30, backgroundColor: COLORS.panelBorder }} />
          <View style={{ alignItems: "center" }}>
            <Text style={{ color: COLORS.textMuted, fontSize: 10, fontWeight: "700", letterSpacing: 0.5 }}>SCALE</Text>
            <Text style={{ color: COLORS.textMain, fontSize: 22, fontWeight: "900", fontFamily: "monospace" }}>
              {(visualAlignmentItem.scale ?? 1).toFixed(2)}x
            </Text>
          </View>
          <View style={{ width: 1, height: 30, backgroundColor: COLORS.panelBorder }} />
          <View style={{ alignItems: "center" }}>
            <Text style={{ color: COLORS.textMuted, fontSize: 10, fontWeight: "700", letterSpacing: 0.5 }}>OFFSET</Text>
            <Text style={{ color: COLORS.textMain, fontSize: 14, fontWeight: "800", fontFamily: "monospace" }}>
              {(visualAlignmentItem.x ?? 0).toFixed(2)}m, {(visualAlignmentItem.y ?? 0).toFixed(2)}m
            </Text>
          </View>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#000" },
  sectionContent: {
    position: "absolute",
    zIndex: 5,
    overflow: "hidden",
  },
  canvasContainer: {
    flex: 1,
    backgroundColor: "#f0f4f8",
  },
  mapOffPlaceholder: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: COLORS.bgBase,
  },
  mapOffTitle: { color: COLORS.textMuted, fontSize: 16, fontWeight: "700", letterSpacing: 0.3 },
  mapOffSub: { color: COLORS.textDim, fontSize: 12, fontWeight: "500" },
  hudLayer: { ...StyleSheet.absoluteFillObject, zIndex: 100, padding: HUD_PAD },
  rightPanelRail: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    width: RIGHT_PANEL_WIDTH,
    zIndex: 120,
  },
  
  mapToolsColumn: {
    position: "absolute",
    zIndex: 95,
    gap: 8,
    maxWidth: 400,
  },
  mapToolsGroupCard: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(18, 18, 22, 0.88)",
    borderRadius: 999,
    paddingVertical: 4,
    paddingHorizontal: 5,
    gap: 3,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
    ...SHADOWS.card,
    alignSelf: "flex-start",
  },
  mapToolsDivider: {
    width: 1,
    height: 16,
    backgroundColor: "rgba(255,255,255,0.10)",
    marginHorizontal: 3,
    borderRadius: 1,
  },
  mapToolCompassWell: {
    borderRadius: 999,
    paddingVertical: 2,
    paddingHorizontal: 4,
    backgroundColor: "rgba(255,255,255,0.04)",
  },
  mapToolChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingVertical: 3,
    paddingLeft: 3,
    paddingRight: 10,
    borderRadius: 999,
    backgroundColor: "transparent",
    borderWidth: 1,
    borderColor: "transparent",
  },
  mapToolChipOn: {
    backgroundColor: "rgba(255,255,255,0.07)",
    borderColor: "rgba(244, 193, 12, 0.42)",
  },
  mapToolChipIcon: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(244, 193, 12, 0.12)",
  },
  mapToolChipIconOn: {
    backgroundColor: COLORS.accentBrand,
  },
  mapToolChipLabel: {
    color: COLORS.textMain,
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.15,
  },
  mapToolChipLabelOn: {
    color: COLORS.accentBrand,
  },
  focusToolBtnGrouped: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 10,
    backgroundColor: "transparent",
  },

  // ── Mark / Layers dropdown popovers ──
  menuPopover: {
    position: "absolute",
    top: "100%",
    marginTop: 18,
    // Left-anchored: these buttons sit at the right end of the tool bar, so
    // opening rightward keeps the panel clear of the left Navbar.
    left: 0,
    backgroundColor: COLORS.panelSolid,
    borderRadius: 16,
    paddingVertical: 8,
    paddingHorizontal: 8,
    borderWidth: 1,
    borderColor: COLORS.panelBorder,
    ...SHADOWS.panel,
    zIndex: 100,
  },
  menuPopoverOptions: {
    width: menuPopoverWidthFor(2, MENU_MODE_TILE_W),
  },
  menuPopoverArrow: {
    position: "absolute",
    top: -6,
    left: 22,
    width: 11,
    height: 11,
    backgroundColor: COLORS.panelSolid,
    borderTopWidth: 1,
    borderLeftWidth: 1,
    borderColor: COLORS.panelBorder,
    borderTopLeftRadius: 3,
    transform: [{ rotate: "45deg" }],
  },
  menuSectionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 6,
    paddingBottom: 8,
  },
  menuSectionLabel: {
    flex: 1,
    color: COLORS.textDim,
    fontSize: 9,
    fontWeight: "800",
    letterSpacing: 1.2,
    textTransform: "uppercase",
  },
  menuSectionHintPill: {
    backgroundColor: COLORS.accentMuted,
    borderWidth: 1,
    borderColor: COLORS.accentBorder,
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  menuSectionHintText: {
    color: COLORS.accentBrand,
    fontSize: 8.5,
    fontWeight: "800",
    letterSpacing: 0.8,
    textTransform: "uppercase",
  },

  menuTileRow: {
    flexDirection: "row",
    flexWrap: "nowrap",
    alignItems: "stretch",
    gap: MENU_TILE_GAP,
  },
  menuIconChip: {
    width: 28,
    height: 28,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: COLORS.surfaceSolid,
  },
  menuIconChipSmall: {
    width: 26,
    height: 26,
    borderRadius: 9,
  },
  menuIconChipOn: {
    backgroundColor: COLORS.accentBrand,
  },

  // Mark → mode tiles
  menuModeTile: {
    width: MENU_MODE_TILE_W,
    padding: 9,
    borderRadius: 14,
    backgroundColor: COLORS.cardSolid,
    borderWidth: 1,
    borderColor: COLORS.panelBorder,
  },
  menuModeTileOn: {
    backgroundColor: COLORS.accentMuted,
    borderColor: COLORS.accentBorder,
  },
  menuModeTileTop: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 8,
  },
  menuTileCheck: {
    width: 16,
    height: 16,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: COLORS.accentBrand,
  },
  menuModeTitle: {
    color: COLORS.textMuted,
    fontSize: 11.5,
    fontWeight: "700",
  },
  menuModeTitleOn: {
    color: COLORS.textMain,
    fontWeight: "800",
  },
  menuModeDesc: {
    color: COLORS.textDim,
    fontSize: 9.5,
    fontWeight: "500",
    marginTop: 2,
  },

  // Layers → toggle tiles
  menuLayerTile: {
    width: MENU_LAYER_TILE_W,
    paddingVertical: 9,
    paddingHorizontal: 3,
    borderRadius: 14,
    alignItems: "center",
    backgroundColor: COLORS.cardSolid,
    borderWidth: 1,
    borderColor: COLORS.panelBorder,
  },
  menuLayerTileOn: {
    backgroundColor: COLORS.accentMuted,
    borderColor: COLORS.accentBorder,
  },
  menuLayerLabel: {
    marginTop: 7,
    color: COLORS.textDim,
    fontSize: 10,
    fontWeight: "700",
    textAlign: "center",
  },
  menuLayerLabelOn: {
    color: COLORS.textMain,
    fontWeight: "800",
  },

  menuDivider: {
    height: 1,
    backgroundColor: COLORS.panelBorder,
    marginVertical: 8,
    marginHorizontal: 2,
  },
  menuGroupHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    paddingVertical: 2,
    paddingHorizontal: 4,
    marginBottom: 6,
  },
  menuGroupTitle: {
    flex: 1,
    color: COLORS.textDim,
    fontSize: 9,
    fontWeight: "800",
    letterSpacing: 1.2,
    textTransform: "uppercase",
  },
  menuCountBadge: {
    backgroundColor: COLORS.surfaceSolid,
    borderWidth: 1,
    borderColor: COLORS.panelBorder,
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 1,
  },
  menuCountText: {
    color: COLORS.textMuted,
    fontSize: 9.5,
    fontWeight: "800",
    letterSpacing: 0.4,
  },

  // Layers → plan segment pills
  menuSegRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 2,
  },
  menuSegPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    paddingVertical: 6,
    paddingHorizontal: 11,
    borderRadius: 999,
    backgroundColor: COLORS.cardSolid,
    borderWidth: 1,
    borderColor: COLORS.panelBorder,
  },
  menuSegPillOn: {
    backgroundColor: COLORS.accentMuted,
    borderColor: COLORS.accentBorder,
  },
  menuSegDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: COLORS.textDim,
  },
  menuSegDotOn: {
    backgroundColor: COLORS.accentBrand,
  },
  menuSegLabel: {
    color: COLORS.textDim,
    fontSize: 10.5,
    fontWeight: "700",
  },
  menuSegLabelOn: {
    color: COLORS.textMain,
    fontWeight: "800",
  },
  menuEmptyText: {
    color: COLORS.textDim,
    fontSize: 11,
    fontWeight: "600",
    paddingHorizontal: 4,
    paddingBottom: 4,
  },
  compassCard: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: COLORS.panelSolid,
    borderRadius: 16,
    paddingVertical: 4,
    paddingHorizontal: 8,
    borderWidth: 1,
    borderColor: COLORS.panelBorder,
    ...SHADOWS.card,
    alignSelf: "flex-start",
  },
  focusToolsRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    alignSelf: "flex-start",
  },
  focusToolBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 12,
    backgroundColor: COLORS.cardSolid,
    borderWidth: 1,
    borderColor: COLORS.panelBorder,
    ...SHADOWS.card,
  },
  focusToolBtnPressed: {
    backgroundColor: COLORS.surfaceSolid,
    transform: [{ scale: 0.97 }],
  },
  focusToolLabel: {
    color: COLORS.textMain,
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.3,
  },
  quickAccessAnchor: {
    width: "100%",
  },
  quickAccessSubNav: {
    position: "absolute",
    zIndex: 92,
    maxWidth: SCREEN_WIDTH - HUD_PAD * 2 - NAV_WIDTH_EXPANDED - 40,
    justifyContent: "center",
  },
  quickAccessSubNavInner: {
    flexDirection: "row",
    alignItems: "stretch",
    backgroundColor: COLORS.navSolid,
    borderTopRightRadius: 16,
    borderBottomRightRadius: 16,
    borderTopLeftRadius: 0,
    borderBottomLeftRadius: 0,
    borderWidth: 1,
    borderColor: COLORS.panelBorder,
    borderLeftWidth: 0,
    paddingVertical: 6,
    paddingHorizontal: 10,
    paddingLeft: 0,
    ...SHADOWS.panel,
  },
  quickAccessSubNavBridge: {
    width: 12,
    backgroundColor: COLORS.navSolid,
    borderColor: COLORS.panelBorder,
  },
  quickAccessSubNavRow: {
    flexDirection: "column",
    alignItems: "stretch",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 14,
    paddingHorizontal: 8,
    minWidth: 188,
  },
  quickSubNavSectionLabel: {
    color: COLORS.textDim,
    fontSize: 9,
    fontWeight: "800",
    letterSpacing: 1.2,
    textTransform: "uppercase",
    paddingHorizontal: 4,
    marginTop: 2,
    marginBottom: 2,
  },
  quickSubNavDivider: {
    height: 1,
    backgroundColor: COLORS.panelBorder,
    marginVertical: 6,
    marginHorizontal: 2,
  },
  quickSubNavItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 12,
    backgroundColor: COLORS.cardSolid,
    borderWidth: 1,
    borderColor: COLORS.panelBorder,
    minHeight: 46,
  },
  quickSubNavItemCompact: {
    minHeight: 42,
    paddingVertical: 8,
  },
  quickSubNavItemActive: {
    backgroundColor: COLORS.accentMuted,
    borderColor: COLORS.accentBorder,
  },
  quickSubNavItemDanger: {
    backgroundColor: COLORS.dangerMuted,
    borderColor: COLORS.dangerBorder,
  },
  quickSubNavItemDangerActive: {
    backgroundColor: COLORS.danger,
    borderColor: COLORS.dangerBorder,
  },
  quickSubNavItemDisabled: {
    opacity: 0.45,
  },
  quickSubNavItemBody: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  quickSubNavSignalBars: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 2,
    height: 12,
    paddingBottom: 1,
  },
  quickSubNavIconWrap: {
    width: 32,
    height: 32,
    borderRadius: 10,
    backgroundColor: COLORS.surfaceSolid,
    alignItems: "center",
    justifyContent: "center",
  },
  quickSubNavIconWrapCompact: {
    width: 28,
    height: 28,
    borderRadius: 8,
  },
  quickSubNavIconWrapActive: {
    backgroundColor: COLORS.accentBrand,
  },
  quickSubNavIconWrapDanger: {
    backgroundColor: COLORS.dangerMuted,
  },
  quickSubNavIconWrapDangerActive: {
    backgroundColor: "rgba(255,255,255,0.18)",
  },
  quickSubNavLabel: {
    color: COLORS.textMuted,
    fontSize: 12,
    fontWeight: "700",
    flex: 1,
  },
  quickSubNavLabelCompact: {
    fontSize: 11,
  },
  quickSubNavLabelActive: {
    color: COLORS.textMain,
    fontWeight: "800",
  },
  quickSubNavLabelDanger: {
    color: COLORS.danger,
    fontWeight: "800",
  },
  quickSubNavLabelDisabled: {
    color: COLORS.textDim,
  },
  exitSessionBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    marginHorizontal: 4,
    marginTop: 4,
    paddingVertical: 8,
    paddingHorizontal: 8,
    borderRadius: 12,
    backgroundColor: COLORS.dangerMuted,
    borderWidth: 1,
    borderColor: COLORS.dangerBorder,
    minHeight: 44,
  },
  exitSessionBtnCollapsed: {
    flexDirection: "column",
    gap: 0,
    paddingVertical: 6,
    minHeight: 42,
  },
  topBarCompass: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    height: 32,
    paddingLeft: 2,
    paddingRight: 4,
    gap: 4,
    minWidth: 52,
  },
  topBarCompassLabel: {
    color: COLORS.textMain,
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 0.2,
    minWidth: 22,
  },
  topBarCompassLabelIdle: {
    color: COLORS.textDim,
  },
  pillButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    height: TOP_BAR_ITEM_HEIGHT,
    paddingHorizontal: 12,
    paddingVertical: 0,
    borderRadius: 20,
    gap: 6,
  },
  pillActiveBrand: {
    backgroundColor: COLORS.accentBrand,
    borderWidth: 1,
    borderColor: COLORS.accentBorder,
  },
  pillOnBadge: {
    backgroundColor: COLORS.accentText,
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  pillOnBadgeText: {
    color: COLORS.accentBrand,
    fontSize: 9,
    fontWeight: "900",
    letterSpacing: 0.6,
  },
  pillTextActive: {
    color: COLORS.accentText,
    fontWeight: "800",
  },
  pillTextIdle: {
    color: COLORS.textMuted,
  },
  rtkPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    height: TOP_BAR_ITEM_HEIGHT,
    paddingVertical: 0,
    paddingHorizontal: 10,
    paddingLeft: 12,
    borderRadius: 20,
    backgroundColor: COLORS.surfaceSolid,
    borderWidth: 1,
    borderColor: COLORS.panelBorder,
    overflow: "hidden",
    minWidth: 132,
  },
  rtkPillActive: {
    backgroundColor: COLORS.successMuted,
    borderColor: COLORS.successBorder,
  },
  rtkPillWarn: {
    backgroundColor: COLORS.warningMuted,
    borderColor: COLORS.warningBorder,
  },
  rtkBars: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 2,
    height: 12,
  },
  rtkBar: {
    width: 3,
    borderRadius: 2,
  },
  rtkPillCopy: {
    gap: 0,
    justifyContent: "center",
  },
  rtkPillMode: {
    color: COLORS.textMuted,
    fontSize: 10,
    fontWeight: "800",
    lineHeight: 12,
    letterSpacing: 0.5,
    textTransform: "uppercase",
  },
  rtkPillStatusRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
  },
  rtkLiveDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  rtkPillStatus: {
    fontSize: 9,
    fontWeight: "600",
    letterSpacing: 0.1,
    lineHeight: 11,
  },
  pillInactive: {
    backgroundColor: COLORS.surfaceSolid,
    borderWidth: 1,
    borderColor: COLORS.panelBorder,
  },
  pillManualIdle: {
    backgroundColor: COLORS.surfaceSolid,
    borderWidth: 1,
    borderColor: COLORS.panelBorder,
  },
  pillActiveWarn: {
    backgroundColor: COLORS.warningMuted,
    borderWidth: 1,
    borderColor: COLORS.warningBorder,
  },
  pillButtonDisabled: {
    opacity: 0.92,
  },
  pillTextWarn: {
    color: COLORS.warning,
    fontWeight: "800",
  },
  pillReadyBadge: {
    backgroundColor: COLORS.cardSolid,
    borderRadius: 6,
    paddingHorizontal: 5,
    paddingVertical: 2,
    borderWidth: 1,
    borderColor: COLORS.panelBorder,
  },
  pillReadyBadgeText: {
    color: COLORS.textMuted,
    fontSize: 8,
    fontWeight: "800",
    letterSpacing: 0.4,
  },
  pillTapBadge: {
    backgroundColor: COLORS.warning,
    borderRadius: 6,
    paddingHorizontal: 5,
    paddingVertical: 2,
  },
  pillTapBadgeText: {
    color: COLORS.accentText,
    fontSize: 8,
    fontWeight: "800",
    letterSpacing: 0.3,
  },
  pillText: { fontWeight: "600", fontSize: 12, textTransform: "uppercase", letterSpacing: 0.4 },
  divider: { width: 1, height: TOP_BAR_ITEM_HEIGHT - 8, backgroundColor: COLORS.panelBorder, marginHorizontal: 2, alignSelf: "center" },

  navbar: {
    position: "absolute",
    left: 20,
    top: 20,
    borderRadius: 22,
    borderWidth: 1,
    paddingVertical: 12,
    paddingHorizontal: NAV_PAD_H,
    justifyContent: "flex-start",
    gap: 6,
    ...SHADOWS.panel,
    overflow: "hidden",
    zIndex: 90,
  },
  navRest: {
    flex: 1,
    overflow: "visible",
    gap: 4,
  },
  navMenuGroup: {
    gap: 0,
    marginBottom: 2,
    alignItems: "stretch",
    width: "100%",
  },
  navMenuPressable: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 4,
    paddingHorizontal: 0,
    borderRadius: 14,
    gap: 0,
    width: "100%",
    overflow: "visible",
  },
  navFieldMarkerLabel: {
    color: COLORS.textDim,
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 1.1,
    textAlign: "left",
    textTransform: "uppercase",
    paddingLeft: 2,
    lineHeight: 14,
    marginBottom: 8,
  },
  navGroupSeparator: {
    height: 1,
    backgroundColor: COLORS.panelBorder,
    marginHorizontal: 2,
    alignSelf: "stretch",
  },
  navSection: { gap: 4 },
  navItem: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-start",
    paddingVertical: 4,
    paddingHorizontal: 0,
    borderRadius: 14,
    gap: 0,
    width: "100%",
    overflow: "visible",
  },
  navItemActive: {
    backgroundColor: "rgba(255,255,255,0.06)",
  },
  navItemDanger: {
    backgroundColor: "transparent",
  },

  navIconWrap: {
    width: NAV_ICON_SIZE,
    height: NAV_ICON_SIZE,
    borderRadius: 13,
    backgroundColor: COLORS.cardSolid,
    borderWidth: 1,
    borderColor: COLORS.panelBorder,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  navIconWrapActive: {
    backgroundColor: COLORS.accentBrand,
    borderColor: COLORS.accentBorder,
  },
  navIconWrapActiveCollapsed: {
    borderColor: COLORS.panelBorder,
  },
  navIconWrapDanger: {
    backgroundColor: COLORS.dangerMuted,
    borderColor: COLORS.dangerBorder,
  },
  navLabelWrap: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    overflow: "hidden",
    gap: 8,
    height: 44,
  },
  navLabel: { color: COLORS.textMuted, fontSize: 13, fontWeight: "600" },
  navLabelActive: { color: COLORS.textMain, fontWeight: "700" },
  navLabelDanger: { color: COLORS.danger, fontWeight: "700" },
  navActiveDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: COLORS.accentBrand,
  },
  navDivider: {
    height: 1,
    backgroundColor: COLORS.panelBorder,
    marginVertical: 8,
    marginHorizontal: 2,
  },
  navToolsSection: {
    gap: 4,
    width: "100%",
  },
  bottomActionBtnDangerPressed: {
    backgroundColor: "#4a1f1f",
  },
  bottomActionIconWrap: {
    width: 34,
    height: 34,
    borderRadius: 10,
    backgroundColor: COLORS.surfaceSolid,
    borderWidth: 1,
    borderColor: COLORS.panelBorder,
    alignItems: "center",
    justifyContent: "center",
  },
  bottomActionIconWrapDanger: {
    backgroundColor: COLORS.dangerMuted,
    borderColor: COLORS.dangerBorder,
  },
  bottomActionLabel: {
    color: COLORS.textMuted,
    fontSize: 9,
    fontWeight: "700",
    letterSpacing: 0.3,
    textAlign: "center",
  },
  bottomActionLabelDanger: {
    color: COLORS.danger,
  },
  fullscreenCloseBtn: {
    position: "absolute",
    top: HUD_PAD,
    right: HUD_PAD,
    zIndex: 300,
    width: 44,
    height: 44,
    borderRadius: 12,
    backgroundColor: COLORS.panelSolid,
    borderWidth: 1,
    borderColor: COLORS.panelBorder,
    alignItems: "center",
    justifyContent: "center",
    ...SHADOWS.panel,
  },

  rightPanelBase: {
    position: "absolute",
    right: 0,
    width: RIGHT_PANEL_WIDTH,
    zIndex: 1,
    flexDirection: "column",
    backgroundColor: COLORS.panelSolid,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: COLORS.panelBorder,
    padding: 18,
    ...SHADOWS.panel,
    overflow: "hidden",
  },
  telemetryPanel: { top: HUD_PAD, right: HUD_PAD },
  missionPanel: { bottom: HUD_PAD, right: HUD_PAD },
  // Content-sized with a ceiling, never a hard pinned height — matches every
  // other floating HUD panel (mapToolsGroupCard, quickAccessSubNav, joystickPanel).
  // Applies in both Mission Control and Manual Control (joystick) modes.
  missionPanelAuto: { maxHeight: "68%", height: "auto" },
  joystickPanel: {
    bottom: HUD_PAD,
    left: HUD_PAD + NAV_WIDTH_COLLAPSED + SIDE_GAP + 8,
    right: undefined,
    width: 300,
    maxHeight: "58%",
    zIndex: 110,
  },
  panelScrollContent: { paddingBottom: 10, gap: 12 },

  panelHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    flexShrink: 0,
    marginBottom: 14,
    paddingBottom: 14,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.panelBorder,
  },
  panelHeaderLeft: { flexDirection: "row", alignItems: "center", gap: 12, flex: 1 },
  panelIconWrap: {
    width: 36,
    height: 36,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
  },
  panelTitleRow: { flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" },
  panelTitle: { color: "#fff", fontSize: 15, fontWeight: "700", letterSpacing: 0.2 },
  panelSubtitle: { color: COLORS.textMuted, fontSize: 11, fontWeight: "500", marginTop: 2 },
  panelCloseBtn: {
    width: 30,
    height: 30,
    borderRadius: 8,
    backgroundColor: COLORS.cardSolid,
    alignItems: "center",
    justifyContent: "center",
  },
  liveBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    backgroundColor: COLORS.successMuted,
    borderWidth: 1,
    borderColor: COLORS.successBorder,
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 999,
  },
  liveDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: COLORS.success },
  liveText: { color: COLORS.success, fontSize: 9, fontWeight: "800", letterSpacing: 0.8 },

  telemetryQuickStrip: {
    flexDirection: "row",
    gap: 6,
    marginBottom: 12,
    flexShrink: 0,
  },
  quickChip: {
    flex: 1,
    backgroundColor: COLORS.cardSolid,
    borderWidth: 1,
    borderColor: COLORS.panelBorder,
    borderRadius: 10,
    paddingHorizontal: 8,
    paddingVertical: 8,
    gap: 3,
    alignItems: "center",
  },
  quickChipLabel: {
    color: COLORS.textDim,
    fontSize: 8,
    fontWeight: "800",
    letterSpacing: 0.8,
    textTransform: "uppercase",
  },
  quickChipValue: {
    color: COLORS.textMain,
    fontSize: 10,
    fontWeight: "700",
    textAlign: "center",
  },
  telemetryScroll: { paddingBottom: 12, gap: 10 },
  telemetryBlock: {
    backgroundColor: COLORS.cardSolid,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: COLORS.panelBorder,
    padding: 12,
    gap: 10,
  },
  telemetryBlockAccent: {
    borderLeftWidth: 3,
    borderLeftColor: COLORS.accentBrand,
    backgroundColor: COLORS.panelSolid,
  },
  telemetryBlockHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  telemetryBlockTitle: {
    color: COLORS.textDim,
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 1.1,
    textTransform: "uppercase",
  },
  coordCard: {
    backgroundColor: COLORS.surfaceSolid,
    borderWidth: 1,
    borderColor: COLORS.panelBorder,
    borderRadius: 10,
    overflow: "hidden",
  },
  coordRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 12,
    paddingVertical: 9,
    gap: 10,
  },
  coordLabel: {
    color: COLORS.textDim,
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 0.8,
    width: 32,
  },
  coordValue: {
    flex: 1,
    color: COLORS.textMain,
    fontSize: 12,
    fontWeight: "700",
    textAlign: "right",
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
  },
  coordDivider: {
    height: 1,
    backgroundColor: COLORS.panelBorder,
  },
  telemetryMissionRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  telemetryMissionLabel: {
    color: COLORS.textMain,
    fontSize: 12,
    fontWeight: "700",
  },
  telemetryMissionHint: {
    color: COLORS.textDim,
    fontSize: 10,
    fontWeight: "500",
    marginTop: 2,
  },
  systemsRow: {
    flexDirection: "row",
    backgroundColor: COLORS.surfaceSolid,
    borderWidth: 1,
    borderColor: COLORS.panelBorder,
    borderRadius: 10,
    overflow: "hidden",
  },
  systemsItem: {
    flex: 1,
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 4,
  },
  systemsDivider: {
    width: 1,
    backgroundColor: COLORS.panelBorder,
  },
  systemsLabel: {
    color: COLORS.textDim,
    fontSize: 9,
    fontWeight: "800",
    letterSpacing: 0.7,
    textTransform: "uppercase",
  },
  systemsValue: {
    color: COLORS.textMain,
    fontSize: 12,
    fontWeight: "700",
  },

  statGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  statTile: {
    width: "47.5%",
    backgroundColor: COLORS.surfaceSolid,
    borderWidth: 1,
    borderColor: COLORS.panelBorder,
    borderRadius: 10,
    padding: 10,
    gap: 6,
  },
  statTileWide: { width: "100%" },
  statTileTop: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  statTileIcon: {
    width: 22,
    height: 22,
    borderRadius: 6,
    alignItems: "center",
    justifyContent: "center",
  },
  statTileLabel: { color: COLORS.textDim, fontSize: 9, fontWeight: "700", letterSpacing: 0.6, textTransform: "uppercase", flex: 1 },
  statTileValue: { color: "#fff", fontSize: 13, fontWeight: "700", fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace" },

  statusPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    borderWidth: 1,
    alignSelf: "flex-start",
  },
  statusPillDot: { width: 7, height: 7, borderRadius: 4 },
  statusPillText: { fontSize: 10, fontWeight: "800", letterSpacing: 0.6 },

  batteryCard: {
    backgroundColor: COLORS.surfaceSolid,
    borderWidth: 1,
    borderColor: COLORS.panelBorder,
    borderRadius: 10,
    padding: 8,
    gap: 6,
  },
  batteryCardHeader: { flexDirection: "row", alignItems: "center", gap: 8 },
  batteryIconWrap: {
    width: 30,
    height: 30,
    borderRadius: 8,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  batteryCardTitle: { fontSize: 17, fontWeight: "800", lineHeight: 19 },
  batteryCardSub: { color: COLORS.textMuted, fontSize: 10, fontWeight: "500", marginTop: 1 },
  batteryPctBadge: {
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  batteryPctBadgeText: {
    fontSize: 8,
    fontWeight: "800",
    letterSpacing: 0.5,
  },
  batteryTrack: { height: 5, backgroundColor: COLORS.panelSolid, borderRadius: 999, overflow: "hidden", borderWidth: 1, borderColor: COLORS.panelBorder },
  batteryFill: { height: "100%", borderRadius: 999 },

  joystickScrollContent: { paddingBottom: 10, gap: 14 },
  manualStatusBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 4,
  },
  manualStatusDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
  },
  manualStatusText: {
    color: COLORS.textMuted,
    fontSize: 12,
    fontWeight: "600",
    textTransform: "capitalize",
  },
  manualMetaRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    paddingHorizontal: 4,
  },
  manualMetaText: {
    color: COLORS.textMuted,
    fontSize: 9.5,
    fontWeight: "700",
    textTransform: "uppercase",
  },
  manualIntentText: {
    color: COLORS.textMuted,
    fontSize: 10,
    textAlign: "center",
    lineHeight: 15,
  },
  manualHintText: {
    color: COLORS.textDim,
    fontSize: 10,
    textAlign: "center",
    lineHeight: 15,
    paddingHorizontal: 4,
  },
  manualHintTextWarn: {
    color: COLORS.danger,
  },
  manualStopReasonText: {
    color: COLORS.warning,
    fontSize: 9.5,
    textAlign: "center",
  },
  joystickCard: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 16,
    borderRadius: 16,
    backgroundColor: COLORS.cardSolid,
    borderWidth: 1,
    borderColor: COLORS.panelBorder,
    position: "relative",
  },
  joystickOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    borderRadius: 16,
    backgroundColor: COLORS.overlay,
  },
  joystickOverlayText: { color: "#fff", fontSize: 11, fontWeight: "600" },

  joystickReadoutRow: {
    flexDirection: "row",
    backgroundColor: COLORS.surfaceSolid,
    borderWidth: 1,
    borderColor: COLORS.panelBorder,
    borderRadius: 12,
    overflow: "hidden",
  },
  joystickReadoutItem: {
    flex: 1,
    alignItems: "center",
    paddingVertical: 10,
    gap: 4,
  },
  joystickReadoutDivider: {
    width: 1,
    backgroundColor: COLORS.panelBorder,
  },
  joystickReadoutLabel: {
    color: COLORS.textDim,
    fontSize: 8,
    fontWeight: "800",
    letterSpacing: 0.8,
    textTransform: "uppercase",
  },
  joystickReadoutValue: {
    color: COLORS.textMain,
    fontSize: 15,
    fontWeight: "700",
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
  },

  acquireSegment: {
    flexDirection: "row",
    borderRadius: 12,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: COLORS.panelBorder,
  },
  acquireSegmentBtn: {
    flex: 1,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
  },
  acquireSegmentBtnDisabled: {
    opacity: 0.45,
  },
  acquireSegmentLeft: { backgroundColor: COLORS.accentBrand },
  acquireSegmentRight: { backgroundColor: COLORS.surfaceSolid },
  acquireSegmentDivider: {
    width: 1,
    backgroundColor: COLORS.panelBorder,
  },
  acquireSegmentText: {
    color: "#fff",
    fontSize: 13,
    fontWeight: "700",
  },
  acquireSegmentTextDark: { color: COLORS.accentText },
  armToggle: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    height: 44,
    borderRadius: 12,
    borderWidth: 1,
  },
  armToggleOn: {
    backgroundColor: COLORS.danger,
    borderColor: COLORS.dangerBorder,
  },
  armToggleOff: {
    backgroundColor: COLORS.cardSolid,
    borderColor: COLORS.panelBorder,
  },
  armToggleText: {
    color: "#fff",
    fontSize: 13,
    fontWeight: "700",
  },

  missionStatusStrip: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    backgroundColor: COLORS.cardSolid,
    borderWidth: 1,
    borderColor: COLORS.panelBorder,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  missionStatusCopy: { flex: 1, gap: 2 },
  missionStatusLabel: {
    color: COLORS.textDim,
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 0.8,
    textTransform: "uppercase",
  },
  missionStatusHint: {
    color: COLORS.textMuted,
    fontSize: 12,
    fontWeight: "600",
  },
  progressCard: {
    backgroundColor: COLORS.cardSolid,
    borderWidth: 1,
    borderColor: COLORS.panelBorder,
    borderRadius: 14,
    padding: 16,
    borderLeftWidth: 3,
    borderLeftColor: COLORS.accentBrand,
  },
  progressTopRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  progressTitle: { color: COLORS.textMain, fontSize: 13, fontWeight: "700" },
  progressPercent: { color: COLORS.accentBrand, fontSize: 16, fontWeight: "800" },
  progressBarTrack: { height: 8, backgroundColor: COLORS.surfaceSolid, borderRadius: 4, marginTop: 14, overflow: "hidden" },
  progressBarFill: { height: "100%", backgroundColor: COLORS.accentBrand, borderRadius: 4 },
  progressMetaRow: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: 14,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: COLORS.panelBorder,
  },
  progressMetaItem: { flex: 1, alignItems: "center", gap: 3 },
  progressMetaLabel: {
    color: COLORS.textDim,
    fontSize: 9,
    fontWeight: "800",
    letterSpacing: 0.6,
    textTransform: "uppercase",
  },
  progressMetaValue: {
    color: COLORS.textMain,
    fontSize: 12,
    fontWeight: "700",
  },
  progressMetaDivider: {
    width: 1,
    height: 28,
    backgroundColor: COLORS.panelBorder,
  },

  missionActionsGrid: { flexDirection: "column", gap: 12 },
  missionSubActionsRow: { flexDirection: "row", width: "100%", gap: 8 },
  missionActionBtn: {
    minHeight: 48,
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 8,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    borderWidth: 1,
  },
  missionActionFull: { width: "100%" },
  missionActionBig: {
    minHeight: 60,
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 14,
    justifyContent: "flex-start",
  },
  missionActionPrimary: { backgroundColor: COLORS.accentBrand, borderColor: COLORS.accentBorder },
  missionActionLabelDark: { color: COLORS.accentText },
  missionActionDanger: { backgroundColor: COLORS.danger, borderColor: COLORS.dangerBorder },
  missionActionWarning: { backgroundColor: "#27272a", borderColor: "#3f3f46" },
  missionActionSecondary: { backgroundColor: COLORS.cardSolid, borderColor: COLORS.panelBorder },
  missionActionIconWrap: {
    width: 28,
    height: 28,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  missionActionIconWrapBig: {
    width: 36,
    height: 36,
    borderRadius: 10,
  },
  missionActionLabel: { color: "#f8fafc", fontSize: 11, fontWeight: "700", letterSpacing: 0.2, flexShrink: 1, textAlign: "center" },
  missionActionLabelBig: { fontSize: 13, fontWeight: "800", textAlign: "left", flex: 1 },

  estopLayer: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 9999,
  },
  estopDraggable: {
    position: "absolute",
    left: 0,
    top: 0,
    width: ESTOP_RING_SIZE,
    height: ESTOP_RING_SIZE,
    alignItems: "center",
    justifyContent: "center",
  },
  estopRingWrap: {
    position: "absolute",
  },
  estopButton: {
    width: ESTOP_SIZE,
    height: ESTOP_SIZE,
    borderRadius: ESTOP_SIZE / 2,
    backgroundColor: "rgba(220, 38, 38, 0.92)",
    borderWidth: 3,
    borderColor: "#fecaca",
    alignItems: "center",
    justifyContent: "center",
  },
  estopText: { color: "#fff", fontSize: 14, fontWeight: "900", marginTop: 2 },
  estopSubText: { color: "rgba(255, 255, 255, 0.75)", fontSize: 9, fontWeight: "700", letterSpacing: 0.4 },

  // ── Click to Mark toolbar styles ──
  drawingToolbar: {
    position: "absolute",
    bottom: 48,
    left: 0,
    right: 0,
    zIndex: 100,
    alignItems: "center",
  },
  drawingToolbarInner: {
    backgroundColor: "rgba(24, 24, 27, 0.95)",
    borderRadius: 16,
    paddingHorizontal: 18,
    paddingVertical: 14,
    borderWidth: 1.5,
    borderColor: "#2e2e34",
    width: "90%",
    maxWidth: 400,
  },
  drawingBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 10,
  },
  drawingBtnText: {
    fontSize: 12,
    fontWeight: "700",
    color: "#f8fafc",
  },
  drawingBtnSecondary: {
    backgroundColor: "#252529",
    borderWidth: 1,
    borderColor: "#2e2e34",
  },
  drawingBtnDanger: {
    backgroundColor: "#3d1818",
    borderWidth: 1,
    borderColor: "#7f2a2a",
  },
  drawingBtnPrimary: {
    backgroundColor: "#f4c10c",
    borderWidth: 1,
    borderColor: "#eab308",
  },
});

interface FreehandCanvasOverlayProps {
  canvasStrokes: { x: number; y: number }[][];
  onStrokeFinished: (stroke: { x: number; y: number }[]) => void;
  COLORS: any;
}

export function FreehandCanvasOverlay({ canvasStrokes, onStrokeFinished, COLORS }: FreehandCanvasOverlayProps) {
  const [currentStroke, setCurrentStroke] = useState<{ x: number; y: number }[]>([]);
  const currentStrokeRef = useRef<{ x: number; y: number }[]>([]);

  const handleDrawBegin = useCallback((x: number, y: number) => {
    const initialStroke = [{ x, y }];
    setCurrentStroke(initialStroke);
    currentStrokeRef.current = initialStroke;
  }, []);

  const handleDrawChange = useCallback((x: number, y: number) => {
    setCurrentStroke((prev) => {
      const nextStroke = [...prev, { x, y }];
      currentStrokeRef.current = nextStroke;
      return nextStroke;
    });
  }, []);

  const handleDrawFinalize = useCallback(() => {
    const current = currentStrokeRef.current;
    if (current.length > 1) {
      onStrokeFinished(current);
    }
    setCurrentStroke([]);
    currentStrokeRef.current = [];
  }, [onStrokeFinished]);

  const panGesture = useMemo(() => {
    return Gesture.Pan()
      .minDistance(0)
      .onBegin((e) => {
        "worklet";
        runOnJS(handleDrawBegin)(e.x, e.y);
      })
      .onChange((e) => {
        "worklet";
        runOnJS(handleDrawChange)(e.x, e.y);
      })
      .onFinalize(() => {
        "worklet";
        runOnJS(handleDrawFinalize)();
      });
  }, [handleDrawBegin, handleDrawChange, handleDrawFinalize]);

  return (
    <GestureDetector gesture={panGesture}>
      <View 
        style={[
          StyleSheet.absoluteFillObject, 
          { zIndex: 150, elevation: 150, backgroundColor: "transparent" }
        ]}
        pointerEvents="auto"
      >
        <Svg style={StyleSheet.absoluteFillObject}>
          {/* Render previously completed strokes */}
          {canvasStrokes.map((stroke, index) => {
            const pointsStr = stroke.map((p) => `${p.x},${p.y}`).join(" ");
            return (
              <Polyline
                key={index}
                points={pointsStr}
                fill="none"
                stroke={COLORS.accentBrand}
                strokeWidth={4.5}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            );
          })}
          {/* Render active stroke currently being drawn */}
          {currentStroke.length > 1 && (
            <Polyline
              points={currentStroke.map((p) => `${p.x},${p.y}`).join(" ")}
              fill="none"
              stroke={COLORS.accentBrand}
              strokeWidth={4.5}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          )}
        </Svg>
      </View>
    </GestureDetector>
  );
}
