/**
 * CSV path order: drag reorder + paint/skip. Minimal UI — details live on the map.
 */

import React, { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import DraggableFlatList, { RenderItemParams, ScaleDecorator } from "react-native-draggable-flatlist";
import { GripVertical } from "lucide-react-native";

import type { PlanLine } from "../../../types/plan";
import { getLineFitMeta } from "../../../utils/csvGeometryReadiness";
import {
  buildCsvExtensionPreviews,
  csvExtensionLengthM,
  type CsvExtensionConfig,
  type CsvExtensionPreview,
} from "../../../utils/csvExtensions";
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
import { getLineLengthM } from "../../../utils/pathWorkflow";
import { FIELDS_COLORS } from "../fieldsTheme";

const DEFAULT_SPEEDS = { markSpeedMs: 0.35, travelSpeedMs: 0.5 };

const PATH_ROW_HEIGHT = 48;
const TRANSIT_ROW_HEIGHT = 28;

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

type ExtensionRow = {
  kind: "extension";
  id: string;
  preview: CsvExtensionPreview;
};

type ListRow = PathRow | TransitRow | ExtensionRow;

type CsvPathOrderStepProps = {
  lines: PlanLine[];
  onOrderChange?: (orderedPaintedLines: PlanLine[], fullOrder: CsvPathOrderEntry[]) => void;
  /** Used for extension length totals / list rows only — toggle lives in Upload. */
  extensionConfig?: CsvExtensionConfig | null;
};

function buildInterleavedRows(
  orderedLines: PlanLine[],
  order: CsvPathOrderEntry[],
  transitPreviews: CsvTransitPreview[],
  extensionPreviews: CsvExtensionPreview[]
): ListRow[] {
  const byId = new Map(order.map((e) => [e.lineId, e]));
  const rows: ListRow[] = [];
  const transitByFrom = new Map(transitPreviews.map((t) => [t.fromLineId, t]));
  const preByLine = new Map(
    extensionPreviews.filter((e) => e.role === "pre").map((e) => [e.lineId, e])
  );
  const aftByLine = new Map(
    extensionPreviews.filter((e) => e.role === "aft").map((e) => [e.lineId, e])
  );

  orderedLines.forEach((line, index) => {
    const entry = byId.get(line.id) ?? {
      lineId: line.id,
      label: line.label,
      paint: true,
    };
    const paint = entry.paint !== false;

    if (paint) {
      const pre = preByLine.get(line.id);
      if (pre) {
        rows.push({ kind: "extension", id: `ext-pre:${pre.id}`, preview: pre });
      }
    }

    rows.push({
      kind: "path",
      id: `path:${line.id}`,
      line,
      entry,
      badge: index + 1,
    });

    if (paint) {
      const aft = aftByLine.get(line.id);
      if (aft) {
        rows.push({ kind: "extension", id: `ext-aft:${aft.id}`, preview: aft });
      }
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

export function CsvPathOrderStep({
  lines,
  onOrderChange,
  extensionConfig = null,
}: CsvPathOrderStepProps) {
  const markLines = useMemo(() => selectMarkPlanLines(lines), [lines]);
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
  /** Last order signature we pushed to parent — avoids setLines loops on every paint rebuild. */
  const lastNotifiedOrderKeyRef = useRef<string>("");

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
  }, [markKey]); // markKey only — not markLines reference (avoids thrash when parent rebuilds transit)

  const painted = useMemo(() => resolveOrderedPaintedLines(markLines, order), [markLines, order]);
  const trajectory = useMemo(
    () =>
      buildOrderedTrajectory(markLines, order, {
        ...DEFAULT_SPEEDS,
        extensions: extensionConfig,
      }),
    [markLines, order, extensionConfig]
  );
  const reversals = useMemo(() => detectReversalWarnings(painted), [painted]);
  const transitPreviews = useMemo(
    () => buildCsvTransitPreviews(markLines, order),
    [markLines, order]
  );
  const extensionPreviews = useMemo(
    () => buildCsvExtensionPreviews(painted, extensionConfig),
    [painted, extensionConfig]
  );
  const extensionLengthM = useMemo(
    () => csvExtensionLengthM(painted, extensionConfig),
    [painted, extensionConfig]
  );

  // Notify parent only when order/paint actually changes — not when map line
  // objects are rebuilt (that was causing Maximum update depth exceeded).
  const orderNotifyKey = useMemo(
    () => order.map((e) => `${e.lineId}:${e.paint !== false ? 1 : 0}`).join("|"),
    [order]
  );
  useEffect(() => {
    if (orderNotifyKey === lastNotifiedOrderKeyRef.current) return;
    lastNotifiedOrderKeyRef.current = orderNotifyKey;
    onOrderChangeRef.current?.(painted, order);
  }, [orderNotifyKey, painted, order]);

  const orderedLines = useMemo(
    () =>
      order
        .map((e) => markLines.find((l) => l.id === e.lineId))
        .filter((l): l is PlanLine => l != null),
    [order, markLines]
  );

  const listRows = useMemo(
    () => buildInterleavedRows(orderedLines, order, transitPreviews, extensionPreviews),
    [orderedLines, order, transitPreviews, extensionPreviews]
  );

  if (markLines.length === 0) {
    return (
      <Text style={{ color: FIELDS_COLORS.textDim, fontSize: 11 }}>
        No paths yet. Import a survey CSV or DXF first.
      </Text>
    );
  }

  const listHeight = Math.min(
    280,
    Math.max(
      100,
      orderedLines.length * PATH_ROW_HEIGHT +
        transitPreviews.length * TRANSIT_ROW_HEIGHT +
        extensionPreviews.length * TRANSIT_ROW_HEIGHT +
        8
    )
  );

  const commitPathOrder = (nextPaths: PlanLine[]) => {
    const idOrder = nextPaths.map((l) => l.id);
    setOrder((prev) => {
      const byId = new Map(prev.map((e) => [e.lineId, e]));
      return idOrder.map((id) => byId.get(id)).filter((e): e is CsvPathOrderEntry => e != null);
    });
  };

  return (
    <View style={{ gap: 8, flex: 1, minHeight: 0 }}>
      {/* One-line totals only */}
      <Text style={{ color: FIELDS_COLORS.textMain, fontSize: 12, fontWeight: "700" }}>
        Paint {trajectory.totals.markLengthM.toFixed(1)} m
        {trajectory.totals.travelLengthM > 0.05
          ? `  ·  Transit ${trajectory.totals.travelLengthM.toFixed(1)} m`
          : ""}
        {extensionLengthM > 0.05
          ? `  ·  Extension ${extensionLengthM.toFixed(1)} m`
          : ""}
        {reversals.length > 0 ? (
          <Text style={{ color: FIELDS_COLORS.warning, fontWeight: "600" }}>
            {`  ·  ${reversals.length} reversal${reversals.length === 1 ? "" : "s"}`}
          </Text>
        ) : null}
      </Text>

      <View
        style={{
          height: listHeight,
          flexGrow: 1,
          minHeight: 100,
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
              return (
                <ScaleDecorator>
                  <View
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      paddingLeft: 40,
                      paddingRight: 12,
                      paddingVertical: 4,
                      backgroundColor: FIELDS_COLORS.panelSolid,
                      borderBottomWidth: 1,
                      borderBottomColor: FIELDS_COLORS.panelBorder,
                    }}
                  >
                    <Text style={{ flex: 1, color: FIELDS_COLORS.textDim, fontSize: 10 }}>
                      transit
                    </Text>
                    <Text style={{ color: FIELDS_COLORS.textDim, fontSize: 10, fontWeight: "600" }}>
                      {item.preview.lengthM.toFixed(1)} m
                    </Text>
                  </View>
                </ScaleDecorator>
              );
            }

            if (item.kind === "extension") {
              return (
                <ScaleDecorator>
                  <View
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      paddingLeft: 40,
                      paddingRight: 12,
                      paddingVertical: 4,
                      backgroundColor: "rgba(139, 92, 246, 0.08)",
                      borderBottomWidth: 1,
                      borderBottomColor: FIELDS_COLORS.panelBorder,
                    }}
                  >
                    <Text style={{ flex: 1, color: "#8b5cf6", fontSize: 10, fontWeight: "700" }}>
                      {item.preview.role === "pre" ? "pre-ext" : "aft-ext"}
                    </Text>
                    <Text style={{ color: "#8b5cf6", fontSize: 10, fontWeight: "600" }}>
                      {item.preview.lengthM.toFixed(2)} m
                    </Text>
                  </View>
                </ScaleDecorator>
              );
            }

            const paint = item.entry.paint !== false;
            const blocked = !getLineFitMeta(item.line).paintable;
            const lengthM = getLineLengthM(item.line);

            return (
              <ScaleDecorator>
                <Pressable
                  onLongPress={drag}
                  delayLongPress={180}
                  disabled={isActive}
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    paddingHorizontal: 10,
                    paddingVertical: 10,
                    gap: 8,
                    minHeight: 44,
                    backgroundColor: isActive
                      ? FIELDS_COLORS.accentMuted
                      : blocked
                        ? FIELDS_COLORS.dangerMuted
                        : FIELDS_COLORS.surfaceSolid,
                    borderBottomWidth: 1,
                    borderBottomColor: FIELDS_COLORS.panelBorder,
                    opacity: paint ? 1 : 0.5,
                  }}
                >
                  <GripVertical size={14} color={FIELDS_COLORS.textDim} />
                  <Text
                    style={{
                      color: paint ? FIELDS_COLORS.accentBrand : FIELDS_COLORS.textDim,
                      fontSize: 11,
                      fontWeight: "800",
                      minWidth: 18,
                    }}
                  >
                    {item.badge}
                  </Text>
                  <Text
                    style={{
                      flex: 1,
                      color: blocked ? FIELDS_COLORS.danger : FIELDS_COLORS.textMain,
                      fontSize: 13,
                      fontWeight: "600",
                    }}
                    numberOfLines={1}
                  >
                    {item.line.label}
                    {blocked ? " · bad" : ""}
                  </Text>
                  {lengthM != null && lengthM > 0 ? (
                    <Text
                      style={{
                        color: FIELDS_COLORS.textDim,
                        fontSize: 11,
                        fontWeight: "600",
                        minWidth: 44,
                        textAlign: "right",
                      }}
                    >
                      {lengthM.toFixed(1)} m
                    </Text>
                  ) : null}
                  <Pressable
                    onPress={() => setOrder((prev) => setPathPaint(prev, item.line.id, !paint))}
                    style={{
                      paddingHorizontal: 8,
                      paddingVertical: 5,
                      borderRadius: 6,
                      minWidth: 48,
                      alignItems: "center",
                      backgroundColor: paint
                        ? FIELDS_COLORS.successMuted
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
                </Pressable>
              </ScaleDecorator>
            );
          }}
        />
      </View>
    </View>
  );
}
