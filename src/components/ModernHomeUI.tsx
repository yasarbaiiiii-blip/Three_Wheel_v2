// @ts-nocheck
import React, { useState, useEffect, useRef, useCallback } from "react";
import { View, Text, Pressable, StyleSheet, ScrollView, Animated, Platform, Modal, TextInput, Dimensions } from "react-native";
import { GestureHandlerRootView, GestureDetector, Gesture } from "react-native-gesture-handler";
import AnimatedReanimated, { useSharedValue, useAnimatedStyle, useAnimatedProps, withSpring, withTiming, cancelAnimation, Easing, runOnJS } from "react-native-reanimated";
import Svg, { Circle as SvgCircle, Line, Polygon, G, Text as SvgText } from "react-native-svg";
import { Battery, Crosshair, Navigation, LocateFixed, Route, Wifi, Hexagon, Circle, ShieldAlert, X, Menu, Play, Square, Pause, SkipForward, Download, MonitorPlay, MapPin, Satellite, Gauge, Activity, Radio, Gamepad2, Target, Zap, Map as MapIcon, Tractor, Maximize2 } from "lucide-react-native";
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

const normalizeHeadingDeg = (deg) => ((deg % 360) + 360) % 360;

const TopBarCompass = ({ headingDeg, hasRoverHeading }) => {
  const size = 34;
  const cx = size / 2;
  const r = size / 2 - 2;
  const displayHeading = hasRoverHeading ? normalizeHeadingDeg(headingDeg) : null;

  return (
    <View style={styles.topBarCompass}>
      <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <SvgCircle
          cx={cx}
          cy={cx}
          r={r}
          fill={COLORS.surfaceSolid}
          stroke={hasRoverHeading ? COLORS.accentBorder : COLORS.panelBorder}
          strokeWidth={1.2}
        />
        <SvgText x={cx} y={9} fontSize={7} fill={COLORS.danger} fontWeight="900" textAnchor="middle">N</SvgText>
        <SvgText x={cx} y={size - 4} fontSize={6} fill={COLORS.textDim} fontWeight="700" textAnchor="middle">S</SvgText>
        <SvgText x={size - 5} y={cx + 2} fontSize={6} fill={COLORS.textDim} fontWeight="700" textAnchor="middle">E</SvgText>
        <SvgText x={5} y={cx + 2} fontSize={6} fill={COLORS.textDim} fontWeight="700" textAnchor="middle">W</SvgText>
        {[0, 45, 90, 135, 180, 225, 270, 315].map((deg) => {
          const tickR = deg % 90 === 0 ? 3 : 1.8;
          const rad = (deg * Math.PI) / 180;
          const inner = r - 7;
          const outer = inner + tickR;
          return (
            <Line
              key={deg}
              x1={cx + inner * Math.sin(rad)}
              y1={cx - inner * Math.cos(rad)}
              x2={cx + outer * Math.sin(rad)}
              y2={cx - outer * Math.cos(rad)}
              stroke={COLORS.textDim}
              strokeWidth={deg % 90 === 0 ? 1.2 : 0.8}
            />
          );
        })}
        <G transform={hasRoverHeading ? `rotate(${displayHeading} ${cx} ${cx})` : undefined}>
          <Polygon
            points={`${cx},${cx - 9} ${cx + 2},${cx} ${cx - 2},${cx}`}
            fill={hasRoverHeading ? COLORS.accentBrand : COLORS.textDim}
          />
          <Polygon
            points={`${cx},${cx + 9} ${cx + 2},${cx} ${cx - 2},${cx}`}
            fill={COLORS.panelBorder}
          />
          <SvgCircle cx={cx} cy={cx} r={2} fill={COLORS.bgBase} stroke={COLORS.textMain} strokeWidth={0.8} />
        </G>
      </Svg>
      <Text style={[styles.topBarCompassLabel, !hasRoverHeading && styles.topBarCompassLabelIdle]}>
        {hasRoverHeading ? `${displayHeading.toFixed(0)}°` : "--"}
      </Text>
    </View>
  );
};

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

const NAV_WIDTH_COLLAPSED = 72;
const NAV_WIDTH_EXPANDED = 248;
const NAV_WIDTH_COMPACT = 56;
const NAV_HEIGHT_COMPACT = 56;
const DOUBLE_TAP_MS = 320;
const HUD_PAD = 20;
const TOP_BAR_ITEM_HEIGHT = 40;
const RIGHT_PANEL_WIDTH = 340;
const SIDE_GAP = 14;
const BOTTOM_PANEL_HEIGHT_RATIO = 0.46;
const NAV_TIMING = { duration: 420, easing: Easing.bezier(0.4, 0, 0.2, 1) };
const SCREEN_WIDTH = Dimensions.get("window").width;
const SCREEN_HEIGHT = Dimensions.get("window").height;
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

const NavBarItem = ({ icon: Icon, label, active, expanded, onPress, danger = false }) => (
  <Pressable
    style={[
      styles.navItem,
      expanded && styles.navItemExpanded,
      expanded && active && styles.navItemActive,
      danger && styles.navItemDanger,
    ]}
    onPress={onPress}
  >
    <View style={[
      styles.navIconWrap,
      active && !danger && styles.navIconWrapActive,
      active && !danger && !expanded && styles.navIconWrapActiveCollapsed,
      danger && styles.navIconWrapDanger,
    ]}>
      <Icon
        color={danger ? COLORS.danger : active ? COLORS.accentText : COLORS.textMuted}
        size={20}
        strokeWidth={2.2}
      />
    </View>
    {expanded && (
      <View style={styles.navLabelWrap}>
        <Text style={[
          styles.navLabel,
          active && !danger && styles.navLabelActive,
          danger && styles.navLabelDanger,
        ]}>
          {label}
        </Text>
        {active && !danger && <View style={styles.navActiveDot} />}
      </View>
    )}
  </Pressable>
);

const MissionActionBtn = ({ icon: Icon, label, onPress, variant = "secondary", fullWidth = false }) => {
  const isPrimary = variant === "primary";
  const isDanger = variant === "danger";
  return (
    <Pressable
      style={[
        styles.missionActionBtn,
        fullWidth && styles.missionActionFull,
        isPrimary && styles.missionActionPrimary,
        isDanger && styles.missionActionDanger,
        !isPrimary && !isDanger && styles.missionActionSecondary,
      ]}
      onPress={onPress}
    >
      <View style={[
        styles.missionActionIconWrap,
        isPrimary && { backgroundColor: COLORS.accentText + "1f" },
        isDanger && { backgroundColor: COLORS.pillSecondary },
        !isPrimary && !isDanger && { backgroundColor: COLORS.surfaceSolid },
      ]}>
        <Icon color={isPrimary ? COLORS.accentText : "#fff"} size={18} strokeWidth={2.2} />
      </View>
      <Text style={[styles.missionActionLabel, isPrimary && styles.missionActionLabelDark]}>{label}</Text>
    </Pressable>
  );
};

const FloatingEStop = ({ visible, onTrigger }) => {
  const posX = useSharedValue(ESTOP_INIT_X);
  const posY = useSharedValue(ESTOP_INIT_Y);
  const dragOriginX = useSharedValue(ESTOP_INIT_X);
  const dragOriginY = useSharedValue(ESTOP_INIT_Y);
  const scale = useSharedValue(1);
  const holdProgress = useSharedValue(0);
  const isHolding = useSharedValue(false);
  const isDragging = useSharedValue(false);

  const clampEStop = (x, y) => {
    "worklet";
    const maxX = ESTOP_HUD_W - ESTOP_RING_SIZE;
    const maxY = ESTOP_HUD_H - ESTOP_RING_SIZE;
    return {
      x: Math.min(maxX, Math.max(0, x)),
      y: Math.min(maxY, Math.max(0, y)),
    };
  };

  const resetHold = () => {
    "worklet";
    isHolding.value = false;
    cancelAnimation(holdProgress);
    holdProgress.value = withTiming(0, { duration: 180 });
    scale.value = withSpring(1, { damping: 20, stiffness: 320 });
  };

  const startHold = () => {
    "worklet";
    isHolding.value = true;
    isDragging.value = false;
    holdProgress.value = 0;
    scale.value = withSpring(1.06, { damping: 18, stiffness: 280 });
    holdProgress.value = withTiming(1, { duration: ESTOP_HOLD_MS }, (finished) => {
      if (finished && isHolding.value) {
        isHolding.value = false;
        runOnJS(onTrigger)();
        holdProgress.value = withTiming(0, { duration: 200 });
        scale.value = withSpring(1);
      }
    });
  };

  const estopGesture = Gesture.Pan()
    .minDistance(0)
    .onBegin(() => {
      dragOriginX.value = posX.value;
      dragOriginY.value = posY.value;
      startHold();
    })
    .onUpdate((event) => {
      const dist = Math.hypot(event.translationX, event.translationY);
      if (dist > ESTOP_DRAG_THRESHOLD) {
        if (!isDragging.value) {
          isDragging.value = true;
          resetHold();
        }
        const next = clampEStop(
          dragOriginX.value + event.translationX,
          dragOriginY.value + event.translationY
        );
        posX.value = next.x;
        posY.value = next.y;
      }
    })
    .onEnd(() => {
      if (isDragging.value) {
        const next = clampEStop(posX.value, posY.value);
        posX.value = next.x;
        posY.value = next.y;
        dragOriginX.value = next.x;
        dragOriginY.value = next.y;
      }
      isDragging.value = false;
      if (isHolding.value) {
        resetHold();
      }
    })
    .onFinalize(() => {
      isDragging.value = false;
      if (isHolding.value) {
        resetHold();
      }
    });

  const containerStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: posX.value },
      { translateY: posY.value },
      { scale: scale.value },
    ],
  }));

  const ringWrapStyle = useAnimatedStyle(() => ({
    opacity: isHolding.value ? 1 : 0,
  }));

  const ringAnimatedProps = useAnimatedProps(() => ({
    strokeDashoffset: ESTOP_RING_CIRC * (1 - holdProgress.value),
  }));

  if (!visible) return null;

  const ringCenter = ESTOP_RING_SIZE / 2;

  return (
    <View style={styles.estopLayer} pointerEvents="box-none">
      <GestureDetector gesture={estopGesture}>
        <AnimatedReanimated.View style={[styles.estopDraggable, containerStyle]}>
          <AnimatedReanimated.View style={[styles.estopRingWrap, ringWrapStyle]} pointerEvents="none">
            <Svg width={ESTOP_RING_SIZE} height={ESTOP_RING_SIZE}>
              <SvgCircle
                cx={ringCenter}
                cy={ringCenter}
                r={ESTOP_RING_RADIUS}
                stroke="rgba(244, 193, 12, 0.22)"
                strokeWidth={ESTOP_RING_STROKE}
                fill="none"
              />
              <AnimatedSvgCircle
                cx={ringCenter}
                cy={ringCenter}
                r={ESTOP_RING_RADIUS}
                stroke={COLORS.accentBrand}
                strokeWidth={ESTOP_RING_STROKE}
                fill="none"
                strokeDasharray={`${ESTOP_RING_CIRC}`}
                strokeLinecap="round"
                transform={`rotate(-90 ${ringCenter} ${ringCenter})`}
                animatedProps={ringAnimatedProps}
              />
            </Svg>
          </AnimatedReanimated.View>
          <View style={styles.estopButton}>
            <ShieldAlert size={32} color="#fff" strokeWidth={2.5} />
            <Text style={styles.estopText}>E-STOP</Text>
            <Text style={styles.estopSubText}>HOLD 1.5s</Text>
          </View>
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
    rtkDefaultMode = "NTRIP", virtualJoystick, onPausePlan,
    mapViewEnabled = false, setMapViewEnabled, renderPlanPreview,
    onFocusRover, onFocusPlan,
    recenterRoverCount, recenterPlanCount,
    currentPage = "home",
    renderSectionContent,
  } = props;

  const isHomePage = currentPage === "home";
  const PAGE_TO_NAV = {
    home: "main",
    fields: "fields",
    settings: "settings",
    howto: "howto",
  };

  // Local UI State
  const [showTelemetry, setShowTelemetry] = useState(true);
  const [showMissionControl, setShowMissionControl] = useState(true);
  const [mapFullscreen, setMapFullscreen] = useState(false);
  const [navExpanded, setNavExpanded] = useState(false);
  const [navIconsVisible, setNavIconsVisible] = useState(true);
  const [activeNav, setActiveNav] = useState(PAGE_TO_NAV[currentPage] || "main");
  const lastMenuTapRef = useRef(0);
  const lastNavTapRef = useRef({ id: null, time: 0 });
  const navWidth = useSharedValue(NAV_WIDTH_COLLAPSED);
  const navHeight = useSharedValue(NAV_HEIGHT_FULL);
  const navBgOpacity = useSharedValue(1);
  const topBarRightInset = useSharedValue(HUD_PAD);
  const [isArmed, setIsArmed] = useState(systemHealth?.armed || false);
  const [visualSelected, setVisualSelected] = useState(false);

  const vehicleMode = normalizeVehicleMode(telemetrySnapshot?.mode ?? systemHealth?.mode);

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
  const roverHeadingDeg = telemetrySnapshot?.heading_ned_deg;
  const hasRoverHeading = roverHeadingDeg != null;
  const distGoal = telemetrySnapshot?.dist_to_goal_m?.toFixed(1) ?? "0.0";
  const speed = telemetrySnapshot?.speed_m_s?.toFixed(2) ?? "0.00";
  const rppState = telemetrySnapshot?.rpp_state_name ?? "N/A";
  const fcuConn = systemHealth?.fcu_connected ? "Connected" : "Disconnected";
  const poseAge = telemetrySnapshot?.pose_age_ms ?? 0;
  const battV = telemetrySnapshot?.battery_v?.toFixed(1) ?? "0.0";
  // Ampere not explicitly in schema, show N/A
  const battA = "N/A";
  const joystickState = virtualJoystick?.state ?? "DISABLED";
  const hasJoystickLease = Boolean(virtualJoystick?.leaseId);
  const joystickActive = virtualJoystick?.joystickActive || telemetrySnapshot?.joystick_active;

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
    if (systemHealth?.armed !== undefined) setIsArmed(systemHealth.armed);
  }, [systemHealth?.armed]);

  useEffect(() => {
    if (!mapViewEnabled && mapFullscreen) setMapFullscreen(false);
  }, [mapViewEnabled, mapFullscreen]);

  useEffect(() => {
    if (!isHomePage && mapFullscreen) setMapFullscreen(false);
  }, [isHomePage, mapFullscreen]);

  const collapseNavbar = useCallback(() => {
    setNavIconsVisible(false);
    setNavExpanded(false);
  }, []);

  useEffect(() => {
    const isCompact = !navIconsVisible;
    const targetWidth = isCompact
      ? NAV_WIDTH_COMPACT
      : navExpanded
        ? NAV_WIDTH_EXPANDED
        : NAV_WIDTH_COLLAPSED;
    const targetHeight = isCompact ? NAV_HEIGHT_COMPACT : NAV_HEIGHT_FULL;

    navWidth.value = withTiming(targetWidth, NAV_TIMING);
    navHeight.value = withTiming(targetHeight, NAV_TIMING);
    navBgOpacity.value = withTiming(isCompact ? 0 : 1, NAV_TIMING);
  }, [navExpanded, navIconsVisible, navWidth, navHeight, navBgOpacity]);

  useEffect(() => {
    setActiveNav(PAGE_TO_NAV[currentPage] || "main");
  }, [currentPage]);

  useEffect(() => {
    if (!isHomePage) {
      topBarRightInset.value = withTiming(HUD_PAD, NAV_TIMING);
      return;
    }
    topBarRightInset.value = withTiming(
      showTelemetry ? HUD_PAD + RIGHT_PANEL_WIDTH + SIDE_GAP : HUD_PAD,
      NAV_TIMING
    );
  }, [isHomePage, showTelemetry, topBarRightInset]);

  const navAnimatedStyle = useAnimatedStyle(() => ({
    width: navWidth.value,
    height: navHeight.value,
    backgroundColor: navBgOpacity.value > 0.01 ? COLORS.navSolid : "transparent",
    borderColor: navBgOpacity.value > 0.01 ? COLORS.panelBorder : "transparent",
  }));

  const topBarAnimatedStyle = useAnimatedStyle(() => ({
    left: HUD_PAD + navWidth.value + SIDE_GAP,
    right: topBarRightInset.value,
  }));

  const sectionContentAnimatedStyle = useAnimatedStyle(() => ({
    left: HUD_PAD + navWidth.value + SIDE_GAP,
    right: HUD_PAD,
    top: HUD_PAD + 56 + SIDE_GAP,
    bottom: HUD_PAD,
  }));

  const handleMenuPress = useCallback(() => {
    const now = Date.now();
    const isDoubleTap = now - lastMenuTapRef.current < DOUBLE_TAP_MS;
    lastMenuTapRef.current = now;

    if (isDoubleTap) {
      collapseNavbar();
      return;
    }

    if (!navIconsVisible) {
      setNavIconsVisible(true);
      return;
    }

    setNavExpanded((v) => !v);
  }, [collapseNavbar, navIconsVisible]);

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
    <AnimatedReanimated.View style={[styles.topBar, topBarAnimatedStyle]} pointerEvents="box-none">
      <View style={styles.topBarCenterWrapper} pointerEvents="box-none">
        <View style={styles.topBarCenter}>
          <TopBarCompass headingDeg={roverHeadingDeg ?? 0} hasRoverHeading={hasRoverHeading} />

          <View style={styles.divider} />

          <View style={styles.topBarPills}>
          <VehicleModePill
            mode={vehicleMode}
            onPress={() => {
              if (vehicleMode === "MANUAL") return;
              if (onSetMode) onSetMode("MANUAL");
              fetch(`${getApiBase()}/api/set_mode`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ mode: "MANUAL" }),
              }).catch(console.error);
            }}
          />

          <View style={styles.divider} />

          <RtkStreamPill
            mode={rtkDefaultMode}
            streaming={rtkRunning}
            healthy={rtkHealthy}
            onPress={() => {
              if (rtkRunning) stopRtk && stopRtk();
              else rtkDefaultMode.toLowerCase() === "lora" ? startLora && startLora() : startNtrip && startNtrip();
            }}
          />

          {isHomePage ? (
            <>
              <View style={styles.divider} />

              <TopBarTogglePill
                icon={Route}
                label="Mission Control"
                active={showMissionControl}
                onPress={() => setShowMissionControl(!showMissionControl)}
              />

              <View style={styles.divider} />

              <TopBarTogglePill
                icon={MonitorPlay}
                label="Telemetry"
                active={showTelemetry}
                onPress={() => setShowTelemetry(!showTelemetry)}
              />
            </>
          ) : null}
          </View>
        </View>
      </View>
    </AnimatedReanimated.View>
  );

  const handleNavPress = (id) => {
    setActiveNav(id);
    if (id === "main") onNav("home");
    if (id === "settings") onNav("settings");
    if (id === "fields") onNav("fields");
    if (id === "howto") onNav("howto");
  };

  const handleNavItemPress = useCallback((id) => {
    const now = Date.now();
    const isDoubleTap =
      lastNavTapRef.current.id === id &&
      now - lastNavTapRef.current.time < DOUBLE_TAP_MS;
    lastNavTapRef.current = { id, time: now };

    if (isDoubleTap) {
      collapseNavbar();
      return;
    }

    handleNavPress(id);
  }, [collapseNavbar, onNav]);

  const renderNavbar = () => (
    <AnimatedReanimated.View style={[styles.navbar, navAnimatedStyle, !navIconsVisible && styles.navbarCompact]}>
      <View style={[styles.navMenuGroup, !navIconsVisible && styles.navMenuGroupCompact]}>
        <Pressable
          style={[
            styles.navMenuPressable,
            !navIconsVisible && styles.navMenuPressableCompact,
            navIconsVisible && navExpanded && styles.navItemExpanded,
            navIconsVisible && navExpanded && styles.navItemActive,
          ]}
          onPress={handleMenuPress}
        >
          {navExpanded && navIconsVisible ? (
            <>
              <View style={[styles.navIconWrap, styles.navIconWrapActive]}>
                <Menu color={COLORS.accentText} size={20} strokeWidth={2.2} />
              </View>
              <View style={styles.navLabelWrap}>
                <Text style={[styles.navLabel, styles.navLabelActive]}>Menu</Text>
                <View style={styles.navActiveDot} />
              </View>
            </>
          ) : (
            <View style={styles.navMenuCollapsed}>
              <View style={[
                styles.navIconWrap,
                navIconsVisible && styles.navIconWrapActive,
                !navIconsVisible && styles.navIconWrapCompact,
              ]}>
                <Menu color={navIconsVisible ? COLORS.accentText : COLORS.textMuted} size={20} strokeWidth={2.2} />
              </View>
            </View>
          )}
        </Pressable>
        {navIconsVisible && (
          <>
            <Text
              style={[styles.navFieldMarkerLabel, navExpanded && styles.navFieldMarkerLabelExpanded]}
              numberOfLines={2}
            >
              Field Marker
            </Text>
            <View style={styles.navGroupSeparator} />
          </>
        )}
      </View>

      {navIconsVisible && (
        <>
          <View style={styles.navSection}>
            {[
              { id: "main", icon: Crosshair, label: "Main Screen" },
              { id: "fields", icon: LocateFixed, label: "Fields" },
              { id: "settings", icon: Navigation, label: "Settings" },
              { id: "howto", icon: Circle, label: "How to" },
            ].map((item) => (
              <NavBarItem
                key={item.id}
                icon={item.icon}
                label={item.label}
                active={activeNav === item.id}
                expanded={navExpanded}
                onPress={() => handleNavItemPress(item.id)}
              />
            ))}
          </View>

          <View style={{ flex: 1 }} />

          {isHomePage ? (
            <>
              <View style={styles.navDivider} />

              <View style={styles.navToolsSection}>
                <NavBarItem
                  icon={MapIcon}
                  label="Focus Plan"
                  active={false}
                  expanded={navExpanded}
                  onPress={() => onFocusPlan?.()}
                />
                <NavBarItem
                  icon={Tractor}
                  label="Focus Rover"
                  active={false}
                  expanded={navExpanded}
                  onPress={() => onFocusRover?.()}
                />
                {setMapViewEnabled ? (
                  <>
                    <NavBarItem
                      icon={Maximize2}
                      label="Fullscreen Map"
                      active={mapFullscreen}
                      expanded={navExpanded}
                      onPress={() => {
                        if (!mapViewEnabled) {
                          setMapViewEnabled(true);
                          setMapFullscreen(true);
                          return;
                        }
                        setMapFullscreen((v) => !v);
                      }}
                    />
                    <NavBarItem
                      icon={MapIcon}
                      label={mapViewEnabled ? "Map On" : "Map Off"}
                      active={mapViewEnabled}
                      expanded={navExpanded}
                      onPress={() => setMapViewEnabled((v) => !v)}
                    />
                  </>
                ) : null}
              </View>
            </>
          ) : null}

          <View style={styles.navDivider} />

          <NavBarItem
            icon={X}
            label="Exit Session"
            active={false}
            expanded={navExpanded}
            danger
            onPress={() => onNav("connection")}
          />
        </>
      )}
    </AnimatedReanimated.View>
  );

  const renderTelemetrySection = () => {
    if (!showTelemetry) return null;
    const battPctClamped = Math.min(100, Math.max(0, batteryPct));
    const fcuTone = systemHealth?.fcu_connected ? COLORS.success : COLORS.danger;

    return (
      <View style={[styles.rightPanelBase, styles.telemetryPanel]}>
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
              <StatTile icon={Target} label="HRMS" value={`${hrms} m`} accent={COLORS.textMuted} />
              <StatTile icon={Target} label="VRMS" value={`${vrms} m`} accent={COLORS.textMuted} />
              <StatTile icon={Activity} label="Pose Age" value={`${poseAge} ms`} accent={COLORS.textMuted} />
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
              <StatTile icon={Route} label="X-Track" value={`${xtrack} m`} accent={COLORS.accentBrand} />
              <StatTile icon={Navigation} label="Heading Err" value={`${headingErr}°`} accent={COLORS.warning} />
              <StatTile icon={Target} label="Dist Goal" value={`${distGoal} m`} accent={COLORS.success} />
              <StatTile icon={Gauge} label="Speed" value={`${speed} m/s`} accent={COLORS.accentBrand} />
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
    if (vehicleMode !== "MANUAL" || missionRunning) return null;

    const statusLabel = joystickActive
      ? "Driving"
      : hasJoystickLease
        ? "Lease active"
        : joystickState.replace(/_/g, " ").toLowerCase();

    return (
      <View style={[styles.rightPanelBase, styles.joystickPanel]}>
        <PanelHeader
          icon={Gamepad2}
          title="Manual Control"
          subtitle={isArmed ? "Ready to drive" : "Arm vehicle first"}
        />
        <ScrollView
          style={styles.panelScroll}
          contentContainerStyle={styles.joystickScrollContent}
          showsVerticalScrollIndicator={false}
          nestedScrollEnabled
        >
          <View style={styles.manualStatusBar}>
            <View style={[styles.manualStatusDot, { backgroundColor: joystickStateTone }]} />
            <Text style={styles.manualStatusText}>{statusLabel}</Text>
          </View>

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
              disabled={!isArmed}
            />
            {!isArmed && (
              <View style={styles.joystickOverlay}>
                <ShieldAlert color="#fff" size={18} strokeWidth={2} />
                <Text style={styles.joystickOverlayText}>Arm to drive</Text>
              </View>
            )}
          </View>

          <View style={styles.manualActionGroup}>
            <View style={styles.acquireSegment}>
              <Pressable style={[styles.acquireSegmentBtn, styles.acquireSegmentLeft]} onPress={handleAcquire}>
                <Text style={[styles.acquireSegmentText, styles.acquireSegmentTextDark]}>Acquire</Text>
              </Pressable>
              <View style={styles.acquireSegmentDivider} />
              <Pressable style={[styles.acquireSegmentBtn, styles.acquireSegmentRight]} onPress={handleRelease}>
                <Text style={styles.acquireSegmentText}>Release</Text>
              </Pressable>
            </View>

            <Pressable
              style={[styles.armToggle, isArmed ? styles.armToggleOn : styles.armToggleOff]}
              onPress={() => {
                onArmVehicle(!isArmed);
                setIsArmed(!isArmed);
              }}
            >
              <ShieldAlert color="#fff" size={16} strokeWidth={2.2} />
              <Text style={styles.armToggleText}>{isArmed ? "Disarm" : "Arm Vehicle"}</Text>
            </Pressable>
          </View>
        </ScrollView>
      </View>
    );
  };

  const renderMissionControl = () => {
    if (!showMissionControl) return null;

    return (
      <View style={[styles.rightPanelBase, styles.missionPanel]}>
        <PanelHeader
          icon={Route}
          title="Mission Control"
          subtitle={missionRunning ? "Mission in progress" : "Ready to start"}
          live={missionRunning}
          onClose={!missionRunning ? () => setShowMissionControl(false) : undefined}
        />

        <ScrollView
          style={styles.panelScroll}
          contentContainerStyle={styles.panelScrollContent}
          showsVerticalScrollIndicator={false}
          nestedScrollEnabled
        >
          <View style={styles.progressCard}>
            <View style={styles.progressTopRow}>
              <View>
                <Text style={styles.progressPercent}>{missionProgress}%</Text>
                <Text style={styles.progressLabel}>Route completed</Text>
              </View>
              <View style={styles.progressEtaBox}>
                <Text style={styles.progressEtaLabel}>ETA</Text>
                <Text style={styles.progressTime}>--:--</Text>
              </View>
            </View>
            <View style={styles.progressBarTrack}>
              <View style={[styles.progressBarFill, { width: `${missionProgress}%` }]} />
              <View style={[styles.progressBarGlow, { left: `${Math.max(0, missionProgress - 2)}%` }]} />
            </View>
          </View>

          <View style={styles.missionActionsGrid}>
            <MissionActionBtn
              icon={missionRunning ? Square : Play}
              label={missionRunning ? "Stop Mission" : "Start Mission"}
              variant={missionRunning ? "danger" : "primary"}
              fullWidth
              onPress={missionRunning ? onStopPlan : onStartPlan}
            />
            <MissionActionBtn icon={Pause} label="Pause" onPress={handlePause} />
            <MissionActionBtn icon={SkipForward} label="Next" onPress={handleNext} />
            <MissionActionBtn icon={Download} label="Export Log" onPress={handleExport} />
          </View>
        </ScrollView>
      </View>
    );
  };

  const hudVisible = !mapFullscreen;

  return (
    <GestureHandlerRootView style={styles.container}>
      {/* Map / home canvas layer */}
      {isHomePage ? (
      <View style={{ ...StyleSheet.absoluteFillObject, zIndex: mapFullscreen ? 200 : 1, backgroundColor: COLORS.bgBase }}>
        {mapViewEnabled ? (
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
          visible={mapViewEnabled}
          recenterRoverTrigger={recenterRoverCount}
          recenterPlanTrigger={recenterPlanCount}
          onSelectPoint={props.onSelectPoint}
        />
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
          style={[styles.sectionContent, sectionContentAnimatedStyle]}
          pointerEvents="box-none"
        >
          {renderSectionContent()}
        </AnimatedReanimated.View>
      ) : null}
      
      {/* HUD Layer */}
      {hudVisible ? (
        <View style={styles.hudLayer} pointerEvents="box-none">
          {renderTopBar()}
          {renderNavbar()}
          {isHomePage ? renderTelemetrySection() : null}
          {isHomePage ? renderJoystickPanel() : null}
          {isHomePage ? renderMissionControl() : null}
          {isHomePage ? <FloatingEStop visible={missionRunning || isArmed} onTrigger={handleEStop} /> : null}
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
    </GestureHandlerRootView>
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
  hudLayer: { ...StyleSheet.absoluteFillObject, zIndex: 10, padding: 20 },
  
  topBar: {
    position: "absolute",
    top: HUD_PAD,
    height: 56,
    zIndex: 100,
  },
  topBarCenterWrapper: {
    flex: 1,
    height: "100%",
    alignItems: "center",
    justifyContent: "center",
  },
  topBarCenter: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: COLORS.panelSolid,
    borderRadius: 30,
    paddingVertical: 4,
    paddingHorizontal: 6,
    gap: 2,
    borderWidth: 1,
    borderColor: COLORS.panelBorder,
    ...SHADOWS.panel,
    maxWidth: "100%",
  },
  topBarPills: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    flexShrink: 1,
  },
  topBarCompass: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    height: TOP_BAR_ITEM_HEIGHT,
    paddingLeft: 6,
    paddingRight: 4,
    gap: 4,
    minWidth: 56,
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
    borderRadius: 20,
    borderWidth: 1,
    paddingVertical: 14,
    paddingHorizontal: 10,
    justifyContent: "flex-start",
    gap: 8,
    ...SHADOWS.panel,
    overflow: "hidden",
    zIndex: 90,
  },
  navbarCompact: {
    paddingVertical: 0,
    paddingHorizontal: 0,
    borderRadius: 14,
    borderWidth: 0,
    shadowOpacity: 0,
    elevation: 0,
  },
  navMenuGroup: {
    gap: 6,
    marginBottom: 2,
    alignItems: "center",
  },
  navMenuGroupCompact: {
    marginBottom: 0,
    gap: 0,
  },
  navMenuPressable: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 8,
    paddingHorizontal: 6,
    borderRadius: 14,
    gap: 12,
    width: "100%",
  },
  navMenuPressableCompact: {
    paddingVertical: 0,
    paddingHorizontal: 0,
    width: NAV_WIDTH_COMPACT,
    height: NAV_HEIGHT_COMPACT,
    alignItems: "center",
    justifyContent: "center",
  },
  navMenuCollapsed: {
    alignItems: "center",
    width: "100%",
  },
  navIconWrapCompact: {
    width: NAV_WIDTH_COMPACT,
    height: NAV_HEIGHT_COMPACT,
    borderRadius: 14,
    backgroundColor: COLORS.navSolid,
    borderColor: COLORS.panelBorder,
    ...SHADOWS.panel,
  },
  navFieldMarkerLabel: {
    color: COLORS.textMuted,
    fontSize: 9,
    fontWeight: "700",
    letterSpacing: 0.6,
    textAlign: "center",
    textTransform: "uppercase",
    paddingHorizontal: 4,
    lineHeight: 12,
  },
  navFieldMarkerLabelExpanded: {
    alignSelf: "flex-start",
    paddingLeft: 14,
    fontSize: 10,
    color: COLORS.textDim,
  },
  navGroupSeparator: {
    height: 1,
    backgroundColor: COLORS.panelBorder,
    marginHorizontal: 10,
    alignSelf: "stretch",
  },
  navSection: { gap: 4 },
  navItem: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 8,
    paddingHorizontal: 6,
    borderRadius: 14,
    gap: 12,
  },
  navItemExpanded: {
    justifyContent: "flex-start",
    width: "100%",
  },
  navItemActive: {
    backgroundColor: COLORS.accentMuted,
    borderWidth: 1,
    borderColor: COLORS.accentBorder,
  },

  navIconWrap: {
    width: 42,
    height: 42,
    borderRadius: 12,
    backgroundColor: COLORS.cardSolid,
    borderWidth: 1,
    borderColor: COLORS.panelBorder,
    alignItems: "center",
    justifyContent: "center",
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
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingRight: 6,
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
    marginVertical: 6,
    marginHorizontal: 8,
  },
  navToolsSection: {
    gap: 4,
    width: "100%",
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
    right: 20,
    width: 340,
    flexDirection: "column",
    backgroundColor: COLORS.panelSolid,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: COLORS.panelBorder,
    padding: 18,
    ...SHADOWS.panel,
    overflow: "hidden",
  },
  telemetryPanel: { top: 20, height: "50%" },
  missionPanel: { bottom: HUD_PAD, height: `${BOTTOM_PANEL_HEIGHT_RATIO * 100}%` },
  joystickPanel: { bottom: HUD_PAD, height: `${BOTTOM_PANEL_HEIGHT_RATIO * 100}%` },
  panelScroll: { flex: 1 },
  panelScrollContent: { paddingBottom: 8, gap: 4 },

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

  manualActionGroup: { gap: 10 },
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

  progressCard: {
    backgroundColor: COLORS.cardSolid,
    borderWidth: 1,
    borderColor: COLORS.panelBorder,
    borderRadius: 14,
    padding: 14,
    marginBottom: 14,
  },
  progressTopRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 12 },
  progressPercent: { color: COLORS.accentBrand, fontSize: 28, fontWeight: "800", lineHeight: 30 },
  progressLabel: { color: COLORS.textMuted, fontSize: 11, fontWeight: "600", marginTop: 2 },
  progressEtaBox: { alignItems: "flex-end" },
  progressEtaLabel: { color: COLORS.textMuted, fontSize: 9, fontWeight: "700", letterSpacing: 0.8, textTransform: "uppercase" },
  progressTime: { color: "#fff", fontSize: 16, fontWeight: "700", marginTop: 2 },
  progressBarTrack: { height: 10, backgroundColor: COLORS.surfaceSolid, borderRadius: 999, overflow: "hidden", position: "relative" },
  progressBarFill: { height: "100%", backgroundColor: COLORS.accentBrand, borderRadius: 999 },
  progressBarGlow: {
    position: "absolute",
    top: 0,
    width: "6%",
    height: "100%",
    backgroundColor: COLORS.pillSecondary,
    borderRadius: 999,
  },

  missionActionsGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  missionActionBtn: {
    width: "48%",
    minHeight: 56,
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    borderWidth: 1,
  },
  missionActionFull: { width: "100%" },
  missionActionPrimary: { backgroundColor: COLORS.accentBrand, borderColor: COLORS.accentBorder },
  missionActionLabelDark: { color: COLORS.accentText },
  missionActionDanger: { backgroundColor: COLORS.danger, borderColor: COLORS.dangerBorder },
  missionActionSecondary: { backgroundColor: COLORS.cardSolid, borderColor: COLORS.panelBorder },
  missionActionIconWrap: {
    width: 32,
    height: 32,
    borderRadius: 9,
    alignItems: "center",
    justifyContent: "center",
  },
  missionActionLabel: { color: "#fff", fontSize: 11, fontWeight: "700", letterSpacing: 0.2, flex: 1 },

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
});
