/**
 * Offset plan — instrument-style control: dial + steppers, then Apply.
 * Parent (App.tsx) owns state and bakes into `lines` on Apply.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Minus, Plus } from "lucide-react-native";

import type { AnchorTarget, AnchorTargetOption } from "../../../utils/missionLayerLines";
import type { PlanBufferDirection, PlanOffsetMode } from "../../../utils/planOffset";
import { normalizeBearingDeg } from "../../../utils/planOffset";
import { CompassDial } from "../CompassDial";
import { FieldsButton, FieldsSegmented } from "../FieldsButtons";
import { PlanTargetDropdown } from "../PlanTargetDropdown";
import { FIELDS_COLORS } from "../fieldsTheme";

export type PlanOffsetCardProps = {
  visible: boolean;
  offsetMode: PlanOffsetMode;
  onOffsetModeChange: (mode: PlanOffsetMode) => void;
  offsetBufferDirection: PlanBufferDirection;
  onOffsetBufferDirectionChange: (direction: PlanBufferDirection) => void;
  offsetDistanceM: number;
  offsetBearingDeg: number;
  onOffsetDistanceChange: (m: number) => void;
  onOffsetBearingChange: (deg: number) => void;
  onApplyOffset: () => void;
  offsetTargetOptions: AnchorTargetOption[];
  offsetTarget: AnchorTarget | null;
  onOffsetTargetChange: (target: AnchorTarget) => void;
  offsetResetAvailable: boolean;
  onResetOffset: () => void;
  onOffsetDragStateChange?: (dragging: boolean) => void;
};

const DIST_STEP = 0.1;
const DIST_MAX = 99.9;

function useHoldRepeat(action: () => void) {
  const actionRef = useRef(action);
  actionRef.current = action;
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stop = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const start = useCallback(() => {
    stop();
    actionRef.current();
    timerRef.current = setInterval(() => actionRef.current(), 110);
  }, [stop]);

  useEffect(() => stop, [stop]);
  return { onPressIn: start, onPressOut: stop };
}

function Stepper({
  label,
  value,
  unit,
  onDec,
  onInc,
}: {
  label: string;
  value: string;
  unit: string;
  onDec: () => void;
  onInc: () => void;
}) {
  return (
    <View style={styles.stepper}>
      <Text style={styles.stepperLabel}>{label}</Text>
      <View style={styles.stepperRow}>
        <StepBtn onHold={onDec} accessibilityLabel={`Decrease ${label}`}>
          <Minus size={16} color={FIELDS_COLORS.textMain} strokeWidth={2.4} />
        </StepBtn>
        <View style={styles.readout}>
          <Text style={styles.readoutValue} numberOfLines={1}>
            {value}
          </Text>
          <Text style={styles.readoutUnit}>{unit}</Text>
        </View>
        <StepBtn onHold={onInc} accessibilityLabel={`Increase ${label}`}>
          <Plus size={16} color={FIELDS_COLORS.textMain} strokeWidth={2.4} />
        </StepBtn>
      </View>
    </View>
  );
}

function StepBtn({
  onHold,
  accessibilityLabel,
  children,
}: {
  onHold: () => void;
  accessibilityLabel: string;
  children: React.ReactNode;
}) {
  const hold = useHoldRepeat(onHold);
  const [down, setDown] = useState(false);
  return (
    <Pressable
      onPressIn={() => {
        setDown(true);
        hold.onPressIn();
      }}
      onPressOut={() => {
        setDown(false);
        hold.onPressOut();
      }}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      android_ripple={{ color: "rgba(255,255,255,0.12)" }}
    >
      <View style={[styles.stepBtn, down && styles.stepBtnDown]}>{children}</View>
    </Pressable>
  );
}

export function PlanOffsetCard({
  visible,
  offsetMode,
  onOffsetModeChange,
  offsetBufferDirection,
  onOffsetBufferDirectionChange,
  offsetDistanceM,
  offsetBearingDeg,
  onOffsetDistanceChange,
  onOffsetBearingChange,
  onApplyOffset,
  offsetTargetOptions,
  offsetTarget,
  onOffsetTargetChange,
  offsetResetAvailable,
  onResetOffset,
  onOffsetDragStateChange,
}: PlanOffsetCardProps) {
  const bumpDistance = useCallback(
    (dir: 1 | -1) => {
      const next = Math.round((offsetDistanceM + dir * DIST_STEP) * 10) / 10;
      onOffsetDistanceChange(Math.min(DIST_MAX, Math.max(0, next)));
    },
    [offsetDistanceM, onOffsetDistanceChange]
  );

  const bumpBearing = useCallback(
    (dir: 1 | -1) => {
      onOffsetBearingChange(normalizeBearingDeg(offsetBearingDeg + dir * 5));
    },
    [offsetBearingDeg, onOffsetBearingChange]
  );

  if (!visible) return null;

  const armed = offsetDistanceM > 0;
  const distLabel = offsetDistanceM.toFixed(1);
  const bearingLabel = String(Math.round(normalizeBearingDeg(offsetBearingDeg))).padStart(3, "0");
  const isShift = offsetMode === "shift";

  return (
    <View style={styles.card}>
      <View style={styles.top}>
        <Text style={styles.title}>Offset</Text>
        <View style={styles.segWrap}>
          <FieldsSegmented
            options={[
              { id: "shift", label: "Shift" },
              { id: "buffer", label: "Buffer" },
            ]}
            value={offsetMode}
            onChange={onOffsetModeChange}
          />
        </View>
      </View>

      {offsetMode === "buffer" ? (
        <FieldsSegmented
          options={[
            { id: "out", label: "Outer" },
            { id: "in", label: "Inner" },
          ]}
          value={offsetBufferDirection}
          onChange={onOffsetBufferDirectionChange}
        />
      ) : null}

      <View style={styles.well}>
        <View style={isShift ? styles.console : styles.consoleSolo}>
          {isShift ? (
            <View style={styles.dialCol}>
              <CompassDial
                size={124}
                bearingDeg={offsetBearingDeg}
                onBearingChange={onOffsetBearingChange}
                onDragStateChange={onOffsetDragStateChange}
                hideDegreeInput
              />
              <Text style={styles.dialCaption}>{bearingLabel}°</Text>
            </View>
          ) : null}

          <View style={styles.meters}>
            <Stepper
              label="Distance"
              value={distLabel}
              unit="m"
              onDec={() => bumpDistance(-1)}
              onInc={() => bumpDistance(1)}
            />
            {isShift ? (
              <Stepper
                label="Bearing"
                value={bearingLabel}
                unit="°"
                onDec={() => bumpBearing(-1)}
                onInc={() => bumpBearing(1)}
              />
            ) : null}
          </View>
        </View>
      </View>

      <PlanTargetDropdown
        options={offsetTargetOptions}
        value={offsetTarget}
        onChange={onOffsetTargetChange}
        placeholder="Whole plan"
        label="Scope"
      />

      <View style={styles.actions}>
        <View style={styles.actionFlex}>
          <FieldsButton label="Apply" onPress={onApplyOffset} disabled={!armed} flex />
        </View>
        <View style={styles.actionFlex}>
          <FieldsButton label="Reset" tone="ghost" onPress={onResetOffset} disabled={!offsetResetAvailable} flex />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 14,
    backgroundColor: "#141418",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
    padding: 12,
    gap: 12,
  },
  top: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  title: {
    color: FIELDS_COLORS.textMain,
    fontSize: 13,
    fontWeight: "800",
    letterSpacing: 0.2,
  },
  segWrap: {
    flex: 1,
    minWidth: 0,
  },
  well: {
    backgroundColor: "#0c0c10",
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.06)",
    padding: 12,
  },
  console: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  consoleSolo: {
    gap: 10,
  },
  dialCol: {
    alignItems: "center",
    gap: 4,
  },
  dialCaption: {
    color: FIELDS_COLORS.textMuted,
    fontSize: 12,
    fontWeight: "800",
    fontVariant: ["tabular-nums"],
    letterSpacing: 0.4,
  },
  meters: {
    flex: 1,
    minWidth: 0,
    gap: 12,
  },
  stepper: {
    gap: 5,
  },
  stepperLabel: {
    color: FIELDS_COLORS.textDim,
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 0.7,
    textTransform: "uppercase",
  },
  stepperRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  stepBtn: {
    width: 40,
    height: 44,
    borderRadius: 12,
    backgroundColor: "#1a1a20",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.10)",
    alignItems: "center",
    justifyContent: "center",
  },
  stepBtnDown: {
    backgroundColor: "rgba(255,255,255,0.10)",
    borderColor: FIELDS_COLORS.accentBorder,
  },
  readout: {
    flex: 1,
    minWidth: 0,
    height: 44,
    borderRadius: 12,
    backgroundColor: "#09090b",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "center",
    gap: 4,
    paddingHorizontal: 6,
  },
  readoutValue: {
    color: FIELDS_COLORS.textMain,
    fontSize: 20,
    fontWeight: "800",
    fontVariant: ["tabular-nums"],
    letterSpacing: -0.4,
  },
  readoutUnit: {
    color: FIELDS_COLORS.textDim,
    fontSize: 11,
    fontWeight: "700",
  },
  actions: {
    flexDirection: "row",
    gap: 8,
  },
  actionFlex: {
    flex: 1,
    minWidth: 0,
  },
});
