/**
 * Phase 3 — CSV path order, paint/skip, transit preview, reversal warnings.
 * Sibling of DXF PathOrderAndSprayStep; only rendered under isLocalCsvFlow.
 *
 * Paths are long-press drag-reorderable. Transit legs between consecutive
 * painted paths are listed (non-draggable) and rebuild when order/paint changes.
 */

import React, { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import DraggableFlatList, { RenderItemParams, ScaleDecorator } from "react-native-draggable-flatlist";
import { GripVertical } from "lucide-react-native";

import type { PlanLine } from "../../../types/plan";
import {
  buildCsvTransitPreviews,
  buildOrderedTrajectory,
  defaultPathOrder,
  detectReversalWarnings,
  resolveOrderedPaintedLines,
  selectMarkPlanLines,
  setPathPaint,
  type CsvPathOrderEntry,
  type CsvTransitPreview,
} from "../../../utils/csvPathOrder";
import { FIELDS_COLORS } from "../fieldsTheme";

const DEFAULT_SPEEDS = { markSpeedMs: 0.35, travelSpeedMs: 0.5 };

/** Path row ~52px + optional transit sub-row ~36px. */
const PATH_ROW_HEIGHT = 52;
const TRANSIT_ROW_HEIGHT = 36;

type PathRow = {
  kind: "path";
  id: string;
  line: PlanLine;
  entry: CsvPathOrderEntry;
  badge: number;
};

type TransitRow = {
  kind: "transit";
  id: string;
  preview: CsvTransitPreview;
};

type ListRow = PathRow | TransitRow;

type CsvPathOrderStepProps = {
  lines: PlanLine[];
  /**
   * Fires when order/paint changes. Parent should persist `fullOrder` and rebuild
   * map transit via applyCsvOrderToPlanLines (end of path N → start of path N+1).
   */
  onOrderChange?: (orderedPaintedLines: PlanLine[], fullOrder: CsvPathOrderEntry[]) => void;
};

function buildInterleavedRows(
  orderedLines: PlanLine[],
  order: CsvPathOrderEntry[],
  transitPreviews: CsvTransitPreview[]
): ListRow[] {
  const byId = new Map(order.map((e) => [e.lineId, e]));
  const rows: ListRow[] = [];
  const transitByFrom = new Map(transitPreviews.map((t) => [t.fromLineId, t]));

  orderedLines.forEach((line, index) => {
    const entry = byId.get(line.id) ?? {
      lineId: line.id,
      label: line.label,
      paint: true,
    };
    rows.push({
      kind: "path",
      id: `path:${line.id}`,
      line,
      entry,
      badge: index + 1,
    });
    // Only show transit after a painted path that actually has a travel leg to the next painted path.
    if (entry.paint !== false) {
      const transit = transitByFrom.get(line.id);
      if (transit) {
        rows.push({
          kind: "transit",
          id: `transit:${transit.id}`,
          preview: transit,
        });
      }
    }
  });

  return rows;
}

export function CsvPathOrderStep({ lines, onOrderChange }: CsvPathOrderStepProps) {
  const markLines = useMemo(() => selectMarkPlanLines(lines), [lines]);
  /** Set of mark ids only — order of `lines` must not reset the operator's drag order. */
  const markKey = useMemo(
    () =>
      markLines
        .map((l) => l.id)
        .slice()
        .sort()
        .join("|"),
    [markLines]
  );

  const [order, setOrder] = useState<CsvPathOrderEntry[]>(() => defaultPathOrder(markLines));
  const onOrderChangeRef = useRef(onOrderChange);
  onOrderChangeRef.current = onOrderChange;

  // Re-sync when marks are added/removed (new CSV / template / clear) — keep drag order.
  useEffect(() => {
    setOrder((prev) => {
      const byId = new Map(prev.map((e) => [e.lineId, e]));
      const markIds = new Set(markLines.map((l) => l.id));
      const next: CsvPathOrderEntry[] = [];
      for (const entry of prev) {
        if (!markIds.has(entry.lineId)) continue;
        const line = markLines.find((l) => l.id === entry.lineId);
        next.push(line ? { ...entry, label: line.label } : entry);
      }
      for (const line of markLines) {
        if (!byId.has(line.id)) {
          next.push({ lineId: line.id, label: line.label, paint: true });
        }
      }
      // Skip state update when membership + paint flags unchanged.
      if (
        next.length === prev.length &&
        next.every(
          (e, i) =>
            e.lineId === prev[i]?.lineId &&
            e.paint === prev[i]?.paint &&
            e.label === prev[i]?.label
        )
      ) {
        return prev;
      }
      return next;
    });
  }, [markKey, markLines]);

  const painted = useMemo(() => resolveOrderedPaintedLines(markLines, order), [markLines, order]);
  const trajectory = useMemo(
    () => buildOrderedTrajectory(markLines, order, DEFAULT_SPEEDS),
    [markLines, order]
  );
  const reversals = useMemo(() => detectReversalWarnings(painted), [painted]);
  const transitPreviews = useMemo(
    () => buildCsvTransitPreviews(markLines, order),
    [markLines, order]
  );

  useEffect(() => {
    onOrderChangeRef.current?.(painted, order);
  }, [painted, order]);

  const orderedLines = useMemo(
    () =>
      order
        .map((e) => markLines.find((l) => l.id === e.lineId))
        .filter((l): l is PlanLine => l != null),
    [order, markLines]
  );

  const listRows = useMemo(
    () => buildInterleavedRows(orderedLines, order, transitPreviews),
    [orderedLines, order, transitPreviews]
  );

  if (markLines.length === 0) {
    return (
      <Text style={{ color: FIELDS_COLORS.textDim, fontSize: 11, lineHeight: 16 }}>
        No mark paths yet. Load a survey CSV (and optional templates) first.
      </Text>
    );
  }

  const pathCount = orderedLines.length;
  const listHeight = Math.min(
    320,
    Math.max(
      120,
      pathCount * PATH_ROW_HEIGHT + transitPreviews.length * TRANSIT_ROW_HEIGHT + 16
    )
  );

  const commitPathOrder = (nextPaths: PlanLine[]) => {
    const idOrder = nextPaths.map((l) => l.id);
    setOrder((prev) => {
      const byId = new Map(prev.map((e) => [e.lineId, e]));
      return idOrder
        .map((id) => byId.get(id))
        .filter((e): e is CsvPathOrderEntry => e != null);
    });
  };

  return (
    <View style={{ gap: 10, flex: 1, minHeight: 0 }}>
      <Text style={{ color: FIELDS_COLORS.textMuted, fontSize: 11, lineHeight: 16 }}>
        Hold and drag a path to reorder. Transit legs (end of one path → start of the next)
        update automatically. Toggle paint to skip a path.
      </Text>

      <View style={{ flexDirection: "row", gap: 12, flexWrap: "wrap" }}>
        <Text style={{ color: FIELDS_COLORS.textMain, fontSize: 12, fontWeight: "700" }}>
          Paint {trajectory.totals.markLengthM.toFixed(1)} m
        </Text>
        <Text style={{ color: FIELDS_COLORS.textMuted, fontSize: 12, fontWeight: "600" }}>
          Transit {trajectory.totals.travelLengthM.toFixed(1)} m
        </Text>
        <Text style={{ color: FIELDS_COLORS.textDim, fontSize: 11 }}>
          {trajectory.totals.markRunCount} path
          {trajectory.totals.markRunCount === 1 ? "" : "s"} · {trajectory.totals.travelRunCount}{" "}
          transit
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

      {/* Fixed height so virtualization works; must stay outside parent ScrollView. */}
      <View
        style={{
          height: listHeight,
          flexGrow: 1,
          minHeight: 120,
          borderRadius: 12,
          borderWidth: 1,
          borderColor: FIELDS_COLORS.panelBorder,
          backgroundColor: FIELDS_COLORS.surfaceSolid,
          overflow: "hidden",
        }}
      >
        <DraggableFlatList
          data={listRows}
          keyExtractor={(item) => item.id}
          onDragEnd={({ data }) => {
            // Drag may move transit rows; only path order is authoritative.
            const nextPaths = data
              .filter((r): r is PathRow => r.kind === "path")
              .map((r) => r.line);
            commitPathOrder(nextPaths);
          }}
          containerStyle={{ flex: 1 }}
          style={{ flex: 1 }}
          scrollEnabled
          nestedScrollEnabled
          showsVerticalScrollIndicator
          activationDistance={8}
          removeClippedSubviews={false}
          windowSize={8}
          maxToRenderPerBatch={14}
          initialNumToRender={14}
          renderItem={({ item, drag, isActive }: RenderItemParams<ListRow>) => {
            if (item.kind === "transit") {
              const t = item.preview;
              return (
                <ScaleDecorator>
                  <View
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      paddingLeft: 36,
                      paddingRight: 12,
                      paddingVertical: 8,
                      gap: 8,
                      backgroundColor: FIELDS_COLORS.panelSolid,
                      borderBottomWidth: 1,
                      borderBottomColor: FIELDS_COLORS.panelBorder,
                    }}
                  >
                    <View
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: 3,
                        backgroundColor: FIELDS_COLORS.textDim,
                      }}
                    />
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text
                        style={{
                          color: FIELDS_COLORS.textMuted,
                          fontSize: 11,
                          fontWeight: "600",
                        }}
                        numberOfLines={1}
                      >
                        Transit: {t.fromLabel} → {t.toLabel}
                      </Text>
                    </View>
                    <Text
                      style={{
                        color: FIELDS_COLORS.textDim,
                        fontSize: 11,
                        fontWeight: "600",
                        minWidth: 48,
                        textAlign: "right",
                      }}
                    >
                      {t.lengthM.toFixed(1)} m
                    </Text>
                  </View>
                </ScaleDecorator>
              );
            }

            const paint = item.entry.paint !== false;
            return (
              <ScaleDecorator>
                <Pressable
                  onLongPress={drag}
                  delayLongPress={180}
                  disabled={isActive}
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    paddingHorizontal: 12,
                    paddingVertical: 11,
                    gap: 10,
                    minHeight: 48,
                    backgroundColor: isActive
                      ? FIELDS_COLORS.accentMuted
                      : FIELDS_COLORS.surfaceSolid,
                    borderBottomWidth: 1,
                    borderBottomColor: FIELDS_COLORS.panelBorder,
                    opacity: paint ? 1 : 0.55,
                  }}
                >
                  <GripVertical size={15} color={FIELDS_COLORS.textDim} />
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text
                      style={{
                        color: FIELDS_COLORS.textMain,
                        fontSize: 13,
                        fontWeight: "700",
                      }}
                      numberOfLines={1}
                    >
                      {item.line.label}
                    </Text>
                    <Text
                      style={{
                        color: FIELDS_COLORS.textDim,
                        fontSize: 11,
                        marginTop: 2,
                      }}
                      numberOfLines={1}
                    >
                      {item.line.entity?.entity_type ?? item.line.layer}
                    </Text>
                  </View>
                  <View
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      gap: 8,
                      flexShrink: 0,
                    }}
                  >
                    <View
                      style={{
                        minWidth: 24,
                        height: 24,
                        borderRadius: 8,
                        backgroundColor: paint
                          ? FIELDS_COLORS.accentMuted
                          : FIELDS_COLORS.panelBorder,
                        borderWidth: 1,
                        borderColor: paint
                          ? FIELDS_COLORS.accentBorder
                          : FIELDS_COLORS.panelBorder,
                        alignItems: "center",
                        justifyContent: "center",
                        paddingHorizontal: 6,
                      }}
                    >
                      <Text
                        style={{
                          color: paint ? FIELDS_COLORS.accentBrand : FIELDS_COLORS.textDim,
                          fontSize: 11,
                          fontWeight: "800",
                        }}
                      >
                        {item.badge}
                      </Text>
                    </View>
                    <Pressable
                      onPress={() =>
                        setOrder((prev) => setPathPaint(prev, item.line.id, !paint))
                      }
                      style={{
                        paddingHorizontal: 10,
                        paddingVertical: 6,
                        borderRadius: 8,
                        minWidth: 52,
                        alignItems: "center",
                        backgroundColor: paint
                          ? FIELDS_COLORS.successMuted
                          : FIELDS_COLORS.surfaceSolid,
                        borderWidth: 1,
                        borderColor: paint
                          ? FIELDS_COLORS.successBorder
                          : FIELDS_COLORS.panelBorder,
                      }}
                    >
                      <Text
                        style={{
                          color: paint ? FIELDS_COLORS.success : FIELDS_COLORS.textMuted,
                          fontSize: 10,
                          fontWeight: "700",
                        }}
                      >
                        {paint ? "Paint" : "Skip"}
                      </Text>
                    </Pressable>
                  </View>
                </Pressable>
              </ScaleDecorator>
            );
          }}
        />
      </View>

      {transitPreviews.length === 0 && painted.length > 1 ? (
        <Text style={{ color: FIELDS_COLORS.textDim, fontSize: 10, lineHeight: 14 }}>
          Paths touch end-to-end — no separate transit legs needed.
        </Text>
      ) : null}
    </View>
  );
}
