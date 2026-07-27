/**
 * Phase 3 — CSV path order, paint/skip, reversal warnings, and length totals.
 * Sibling of DXF PathOrderAndSprayStep; only rendered under isLocalCsvFlow.
 */

import React, { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";

import type { PlanLine } from "../../../types/plan";
import {
  buildOrderedTrajectory,
  defaultPathOrder,
  detectReversalWarnings,
  resolveOrderedPaintedLines,
  selectMarkPlanLines,
  setPathPaint,
  type CsvPathOrderEntry,
} from "../../../utils/csvPathOrder";
import { DraggableReorderList } from "../DraggableReorderList";
import { FIELDS_COLORS } from "../fieldsTheme";

const DEFAULT_SPEEDS = { markSpeedMs: 0.35, travelSpeedMs: 0.5 };

type CsvPathOrderStepProps = {
  lines: PlanLine[];
  /** When order changes, parent may rebuild map transit overlays. */
  onOrderChange?: (orderedPaintedLines: PlanLine[], fullOrder: CsvPathOrderEntry[]) => void;
};

export function CsvPathOrderStep({ lines, onOrderChange }: CsvPathOrderStepProps) {
  const markLines = useMemo(() => selectMarkPlanLines(lines), [lines]);
  const markKey = useMemo(() => markLines.map((l) => l.id).join("|"), [markLines]);

  const [order, setOrder] = useState<CsvPathOrderEntry[]>(() => defaultPathOrder(markLines));
  const onOrderChangeRef = useRef(onOrderChange);
  onOrderChangeRef.current = onOrderChange;

  // Re-sync when the mark set changes (new CSV / template add / clear).
  useEffect(() => {
    setOrder((prev) => {
      const byId = new Map(prev.map((e) => [e.lineId, e]));
      const next: CsvPathOrderEntry[] = markLines.map((l) => {
        const existing = byId.get(l.id);
        return existing
          ? { ...existing, label: l.label }
          : { lineId: l.id, label: l.label, paint: true };
      });
      return next;
    });
  }, [markKey, markLines]);

  const painted = useMemo(() => resolveOrderedPaintedLines(markLines, order), [markLines, order]);
  const trajectory = useMemo(
    () => buildOrderedTrajectory(markLines, order, DEFAULT_SPEEDS),
    [markLines, order]
  );
  const reversals = useMemo(() => detectReversalWarnings(painted), [painted]);

  useEffect(() => {
    onOrderChangeRef.current?.(painted, order);
  }, [painted, order]);

  if (markLines.length === 0) {
    return (
      <Text style={{ color: FIELDS_COLORS.textDim, fontSize: 11, lineHeight: 16 }}>
        No mark paths yet. Load a survey CSV (and optional templates) first.
      </Text>
    );
  }

  const orderedLines = order
    .map((e) => markLines.find((l) => l.id === e.lineId))
    .filter((l): l is PlanLine => l != null);

  return (
    <View style={{ gap: 10 }}>
      <Text style={{ color: FIELDS_COLORS.textMuted, fontSize: 11, lineHeight: 16 }}>
        Drag to set driving order. Toggle paint to skip a path. Travel legs are built between
        consecutive painted paths.
      </Text>

      <View style={{ flexDirection: "row", gap: 12, flexWrap: "wrap" }}>
        <Text style={{ color: FIELDS_COLORS.textMain, fontSize: 12, fontWeight: "700" }}>
          Paint {trajectory.totals.markLengthM.toFixed(1)} m
        </Text>
        <Text style={{ color: FIELDS_COLORS.textMuted, fontSize: 12, fontWeight: "600" }}>
          Travel {trajectory.totals.travelLengthM.toFixed(1)} m
        </Text>
        <Text style={{ color: FIELDS_COLORS.textDim, fontSize: 11 }}>
          {trajectory.totals.markRunCount} mark · {trajectory.totals.travelRunCount} travel runs
        </Text>
      </View>

      {reversals.map((r, i) => (
        <Text
          key={`${r.fromIndex}-${r.toIndex}-${i}`}
          style={{ color: FIELDS_COLORS.warning, fontSize: 11, lineHeight: 15 }}
        >
          Reversal warning: {r.fromLabel} → {r.toLabel} turns {r.headingChangeDeg.toFixed(0)}°
          (threshold 120°).
        </Text>
      ))}

      <View
        style={{
          maxHeight: 280,
          borderRadius: 10,
          borderWidth: 1,
          borderColor: FIELDS_COLORS.panelBorder,
          overflow: "hidden",
        }}
      >
        <DraggableReorderList
          data={orderedLines}
          onDragEnd={(next) => {
            const idOrder = next.map((l) => l.id);
            setOrder((prev) => {
              const byId = new Map(prev.map((e) => [e.lineId, e]));
              return idOrder
                .map((id) => byId.get(id))
                .filter((e): e is CsvPathOrderEntry => e != null);
            });
          }}
          renderExtraRight={(item) => {
            const entry = order.find((e) => e.lineId === item.id);
            const paint = entry?.paint !== false;
            const badge = order.findIndex((e) => e.lineId === item.id) + 1;
            return (
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <View
                  style={{
                    minWidth: 22,
                    height: 22,
                    borderRadius: 11,
                    backgroundColor: paint ? FIELDS_COLORS.tealDark : FIELDS_COLORS.panelBorder,
                    alignItems: "center",
                    justifyContent: "center",
                    paddingHorizontal: 6,
                  }}
                >
                  <Text style={{ color: "#fff", fontSize: 11, fontWeight: "800" }}>{badge}</Text>
                </View>
                <Pressable
                  onPress={() => setOrder((prev) => setPathPaint(prev, item.id, !paint))}
                  style={{
                    paddingHorizontal: 10,
                    paddingVertical: 6,
                    borderRadius: 8,
                    backgroundColor: paint ? "#166534" : FIELDS_COLORS.panelBorder,
                  }}
                >
                  <Text style={{ color: "#fff", fontSize: 10, fontWeight: "700" }}>
                    {paint ? "Paint" : "Skip"}
                  </Text>
                </Pressable>
              </View>
            );
          }}
        />
      </View>
    </View>
  );
}

