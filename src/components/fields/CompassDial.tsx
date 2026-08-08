/**
 * Drag-to-aim compass bearing picker for Offset Plan. Visual language borrows
 * from Compass.tsx (this app's only other compass UI, the live rover-heading
 * gauge) — ring, 45-degree ticks, N/S/E/W labels, two-triangle needle — scaled
 * up for touch input and re-accented violet to match the "armed card" family
 * this control lives inside (PlanOffsetCard, AnchorPanel, Enable Extension all
 * use #8b5cf6, not FIELDS_COLORS.accentBrand's yellow, which is reserved for
 * the rover-heading gauge elsewhere and is never shown adjacent to this one).
 *
 * Gesture: react-native-gesture-handler's Gesture.Pan() + GestureDetector,
 * driven by reanimated's runOnJS — same shape as ManualJoystick.tsx, this
 * app's only existing circular drag control. Deliberately never PanResponder:
 * docs/gesture_crash.md documents an already-diagnosed crash in this tree from
 * mixing PanResponder with gesture-handler.
 *
 * Unlike ManualJoystick (which uses translationX/Y because it recenters on
 * release), this dial holds whatever bearing was last set, so it reads the
 * touch's absolute position within the gesture view (event.x/y) on both
 * .onBegin (a bare tap sets a bearing immediately) and .onUpdate (dragging
 * refines it) — never .onEnd/spring-back.
 */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Text, TextInput, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { runOnJS } from "react-native-reanimated";
import Svg, { Circle as SvgCircle, G, Line, Polygon, Text as SvgText } from "react-native-svg";

import { normalizeBearingDeg } from "../../utils/planOffset";
import { bearingFromOffset } from "./compassDialMath";
import { FIELDS_COLORS } from "./fieldsTheme";

export type CompassDialProps = {
  /** Controlled — any range accepted, displayed normalized into [0,360). */
  bearingDeg: number;
  onBearingChange: (deg: number) => void;
  size?: number;
  disabled?: boolean;
  /**
   * Fired true on touch-down, false when the drag finalizes (release, cancel,
   * or failed recognition). Not fired by the degree TextInput's manual edits —
   * only an actual dial drag counts as "dragging."
   */
  onDragStateChange?: (dragging: boolean) => void;
};

const NEEDLE_COLOR = "#8b5cf6";
const TICK_DEGREES = [0, 45, 90, 135, 180, 225, 270, 315];
/** Touches this close to the center resolve to a numerically noisy angle — ignore them. */
const DEAD_ZONE_PX = 4;

export function CompassDial({
  bearingDeg,
  onBearingChange,
  size = 140,
  disabled = false,
  onDragStateChange,
}: CompassDialProps) {
  const cx = size / 2;
  const r = size / 2 - 10;
  const displayBearing = normalizeBearingDeg(bearingDeg);

  const [draft, setDraft] = useState(() => String(Math.round(normalizeBearingDeg(bearingDeg))));
  useEffect(() => {
    setDraft(String(Math.round(normalizeBearingDeg(bearingDeg))));
  }, [bearingDeg]);

  const emitFromTouch = useCallback(
    (x: number, y: number) => {
      const dx = x - cx;
      const dy = y - cx;
      if (Math.hypot(dx, dy) < DEAD_ZONE_PX) return;
      onBearingChange(bearingFromOffset(dx, dy));
    },
    [cx, onBearingChange]
  );

  const panGesture = useMemo(
    () =>
      Gesture.Pan()
        .enabled(!disabled)
        .minDistance(0)
        .onBegin((e) => {
          if (onDragStateChange) runOnJS(onDragStateChange)(true);
          runOnJS(emitFromTouch)(e.x, e.y);
        })
        .onUpdate((e) => {
          runOnJS(emitFromTouch)(e.x, e.y);
        })
        .onFinalize(() => {
          if (onDragStateChange) runOnJS(onDragStateChange)(false);
        }),
    [disabled, emitFromTouch, onDragStateChange]
  );

  return (
    <View style={{ alignItems: "center", opacity: disabled ? 0.5 : 1 }}>
      <GestureDetector gesture={panGesture}>
        <View style={{ width: size, height: size }}>
          <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
            <SvgCircle
              cx={cx}
              cy={cx}
              r={r}
              fill={FIELDS_COLORS.cardSolid}
              stroke={FIELDS_COLORS.panelBorder}
              strokeWidth={1.5}
            />

            <SvgText x={cx} y={22} fontSize={12} fontWeight="900" fill={FIELDS_COLORS.danger} textAnchor="middle">
              N
            </SvgText>
            <SvgText x={cx} y={size - 12} fontSize={11} fontWeight="700" fill={FIELDS_COLORS.textDim} textAnchor="middle">
              S
            </SvgText>
            <SvgText x={size - 15} y={cx + 4} fontSize={11} fontWeight="700" fill={FIELDS_COLORS.textDim} textAnchor="middle">
              E
            </SvgText>
            <SvgText x={15} y={cx + 4} fontSize={11} fontWeight="700" fill={FIELDS_COLORS.textDim} textAnchor="middle">
              W
            </SvgText>

            {TICK_DEGREES.map((deg) => {
              const major = deg % 90 === 0;
              const tickLen = major ? 7 : 4;
              const rad = (deg * Math.PI) / 180;
              const inner = r - 12;
              const outer = inner + tickLen;
              return (
                <Line
                  key={deg}
                  x1={cx + inner * Math.sin(rad)}
                  y1={cx - inner * Math.cos(rad)}
                  x2={cx + outer * Math.sin(rad)}
                  y2={cx - outer * Math.cos(rad)}
                  stroke={FIELDS_COLORS.textDim}
                  strokeWidth={major ? 2 : 1.2}
                />
              );
            })}

            <G transform={`rotate(${displayBearing} ${cx} ${cx})`}>
              <Polygon points={`${cx},${cx - (r - 16)} ${cx + 5},${cx} ${cx - 5},${cx}`} fill={NEEDLE_COLOR} />
              <Polygon points={`${cx},${cx + (r - 30)} ${cx + 5},${cx} ${cx - 5},${cx}`} fill={FIELDS_COLORS.panelBorder} />
              <SvgCircle cx={cx} cy={cx} r={4} fill={FIELDS_COLORS.bgBase} stroke={FIELDS_COLORS.textMain} strokeWidth={1} />
            </G>
          </Svg>
        </View>
      </GestureDetector>

      <View style={{ flexDirection: "row", alignItems: "center", gap: 4, marginTop: 10 }}>
        <TextInput
          style={{
            height: 34,
            width: 60,
            textAlign: "center",
            backgroundColor: FIELDS_COLORS.cardSolid,
            borderWidth: 1,
            borderColor: FIELDS_COLORS.panelBorder,
            borderRadius: 6,
            fontSize: 14,
            fontWeight: "700",
            color: FIELDS_COLORS.textMain,
          }}
          value={draft}
          editable={!disabled}
          onChangeText={(v) => {
            setDraft(v);
            const n = parseFloat(v);
            if (!Number.isFinite(n)) return;
            onBearingChange(n);
          }}
          onBlur={() => {
            const n = parseFloat(draft);
            const normalized = normalizeBearingDeg(Number.isFinite(n) ? n : 0);
            onBearingChange(normalized);
            setDraft(String(Math.round(normalized)));
          }}
          keyboardType="numeric"
        />
        <Text style={{ fontSize: 14, fontWeight: "700", color: FIELDS_COLORS.textMuted }}>°</Text>
      </View>
    </View>
  );
}
