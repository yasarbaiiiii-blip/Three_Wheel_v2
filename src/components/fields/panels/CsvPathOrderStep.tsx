/**
 * CSV path order: drag reorder + paint/skip. Minimal UI — details live on the map.
 */

import React, { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import DraggableFlatList, { RenderItemParams, ScaleDecorator } from "react-native-draggable-flatlist";
import { ArrowDownUp, GripVertical } from "lucide-react-native";

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
  detectCurveDirectionWarnings,
  detectDegenerateEntityWarnings,
  detectReversalWarnings,
  resolveOrderedPaintedLines,
  reversePathOrder,
  selectMarkPlanLines,
  setPathPaint,
  type CsvPathOrderEntry,
  type CsvTransitPreview,
} from "../../../utils/csvPathOrder";
import { getLineLengthM, type SelectLineFn } from "../../../utils/pathWorkflow";
import { CsvWarningsPanel } from "../CsvWarningsPanel";
import { FIELDS_COLORS } from "../fieldsTheme";

const DEFAULT_SPEEDS = { markSpeedMs: 0.35, travelSpeedMs: 0.5 };

const PATH_ROW_HEIGHT = 48;
const TRANSIT_ROW_HEIGHT = 28;
/** Keep a couple of rows visible even when the card is squeezed, so drag still works. */
const MIN_LIST_HEIGHT = 120;

/**
 * Width of the left strip where a drag may START — and, critically, the ONLY place where
 * this list's pan gesture is allowed to claim a touch.
 *
 * DraggableFlatList wraps the list in a `Gesture.Pan()` configured with
 * `activeOffsetY([-activationDistance, +activationDistance])`, so any vertical swipe past
 * that threshold activates the pan. Upstream that is harmless because the library renders
 * react-native-gesture-handler's FlatList — a NativeViewGestureHandler that RNGH arbitrates
 * against the pan, so scrolling still wins when no row is being dragged. This project patches
 * that import back to React Native's plain FlatList (scripts/patch-draggable-flatlist.js, run
 * on postinstall, to dodge the "Failed to obtain view for NativeViewGestureHandler" crash
 * documented in docs/gesture_crash.md). RNGH then has no handle on the list's native scroll:
 * the pan activates, the native ScrollView's touches get cancelled, and because no drag is in
 * progress the pan itself does nothing — the list simply refuses to scroll.
 *
 * Confining the pan's hit area to this strip gives the rest of the row back to the native
 * scroller. Drag therefore has to start on the grip handle, which is why the grip — not the
 * whole row — is what calls `drag` below. Keep the two in sync: a long-press that starts
 * outside this strip would set an active key the pan never tracks, wedging the list.
 */
const DRAG_HANDLE_WIDTH = 44;

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
  /** Shared with the map — tap a row to highlight that path on the plan. */
  selectedLineId?: string | null;
  onSelectLine?: SelectLineFn;
  /** Used for extension length totals / list rows only — toggle lives in Upload. */
  extensionConfig?: CsvExtensionConfig | null;
  /**
   * Step content that scrolls WITH the rows, above and below them.
   *
   * The row list is a VirtualizedList, so the card body can never be wrapped in a ScrollView
   * to make the whole step scroll — that is the nesting the panel layout goes out of its way
   * to avoid. Handing the surrounding content to the list as its header/footer gets the same
   * result with one scroller: intro copy, Send/Load buttons and hints stay reachable no
   * matter how many rows there are or how short the panel column is.
   */
  listHeader?: React.ReactNode;
  listFooter?: React.ReactNode;
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
  selectedLineId = null,
  onSelectLine,
  extensionConfig = null,
  listHeader = null,
  listFooter = null,
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
  const curveDirectionWarnings = useMemo(
    () => detectCurveDirectionWarnings(painted),
    [painted]
  );
  const degenerateEntityWarnings = useMemo(
    () => detectDegenerateEntityWarnings(painted),
    [painted]
  );
  const transitPreviews = useMemo(
    () => buildCsvTransitPreviews(markLines, order, extensionConfig),
    [markLines, order, extensionConfig]
  );
  const extensionPreviews = useMemo(
    () => buildCsvExtensionPreviews(painted, extensionConfig),
    [painted, extensionConfig]
  );
  const extensionLengthM = useMemo(
    () => csvExtensionLengthM(painted, extensionConfig),
    [painted, extensionConfig]
  );
  const pathWarningItems = useMemo(() => {
    const items: string[] = [];
    for (const w of reversals) {
      items.push(`${w.fromLabel} → ${w.toLabel} · ${w.headingChangeDeg.toFixed(0)}°`);
    }
    for (const w of curveDirectionWarnings) {
      items.push(`${w.label} · extra ${w.wastedM.toFixed(1)} m`);
    }
    for (const w of degenerateEntityWarnings) {
      items.push(`${w.label} · ${(w.lengthM * 100).toFixed(0)} cm`);
    }
    return items;
  }, [reversals, curveDirectionWarnings, degenerateEntityWarnings]);

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

  const commitPathOrder = (nextPaths: PlanLine[]) => {
    const idOrder = nextPaths.map((l) => l.id);
    setOrder((prev) => {
      const byId = new Map(prev.map((e) => [e.lineId, e]));
      return idOrder.map((id) => byId.get(id)).filter((e): e is CsvPathOrderEntry => e != null);
    });
  };

  return (
    <View style={{ gap: 8, flex: 1, minHeight: 0 }}>
      {/* One-line totals — pinned above the scroller so it never scrolls out of view */}
      {markLines.length > 0 ? (
        <View style={{ gap: 6 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Text style={{ flex: 1, color: FIELDS_COLORS.textMuted, fontSize: 12, fontWeight: "700" }}>
              {trajectory.totals.markLengthM.toFixed(1)} m
              {trajectory.totals.travelLengthM > 0.05
                ? `  ·  ${trajectory.totals.travelLengthM.toFixed(1)} m transit`
                : ""}
              {extensionLengthM > 0.05
                ? `  ·  ${extensionLengthM.toFixed(1)} m ext`
                : ""}
            </Text>
            {order.length >= 2 ? (
              <Pressable
                onPress={() => setOrder((prev) => reversePathOrder(prev))}
                hitSlop={8}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 6,
                  paddingHorizontal: 10,
                  paddingVertical: 6,
                  borderRadius: 8,
                  borderWidth: 1,
                  borderColor: FIELDS_COLORS.panelBorder,
                  backgroundColor: FIELDS_COLORS.cardSolid,
                }}
              >
                <ArrowDownUp size={13} color={FIELDS_COLORS.textMuted} strokeWidth={2.2} />
                <Text style={{ color: FIELDS_COLORS.textMain, fontSize: 11, fontWeight: "700" }}>
                  Reverse
                </Text>
              </Pressable>
            ) : null}
          </View>
        </View>
      ) : null}

      <CsvWarningsPanel
        title="Warnings"
        advisory={pathWarningItems}
        defaultExpanded={false}
        maxVisible={6}
      />

      {/*
        Take the whole area the card gives us and let the list scroll inside it, rather than
        pinning a fixed height. The old `height: min(280, …)` clipped mid-row as soon as the
        rows exceeded it — a square with per-line extensions is 4 paths + 8 run-ups + the
        connectors between them, which is well past 280 px.
      */}
      <View
        style={{
          flex: 1,
          minHeight: MIN_LIST_HEIGHT,
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
          dragHitSlop={{ width: DRAG_HANDLE_WIDTH, left: 0 }}
          removeClippedSubviews={false}
          windowSize={8}
          maxToRenderPerBatch={14}
          initialNumToRender={14}
          keyboardShouldPersistTaps="handled"
          ListHeaderComponent={
            listHeader ? <View style={{ padding: 10, gap: 10 }}>{listHeader}</View> : null
          }
          ListEmptyComponent={
            <Text style={{ color: FIELDS_COLORS.textDim, fontSize: 12, padding: 12 }}>
              No paths yet
            </Text>
          }
          ListFooterComponent={
            listFooter ? <View style={{ padding: 10, gap: 10 }}>{listFooter}</View> : null
          }
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
                    <Text style={{ flex: 1, color: FIELDS_COLORS.textDim, fontSize: 10, fontWeight: "700" }}>
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
            const fitMeta = getLineFitMeta(item.line);
            const blocked = !fitMeta.paintable;
            const lengthM = getLineLengthM(item.line);
            const selected = selectedLineId === item.line.id;

            return (
              <ScaleDecorator>
                <View
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    paddingHorizontal: 10,
                    paddingVertical: 10,
                    gap: 8,
                    minHeight: 44,
                    backgroundColor: isActive
                      ? FIELDS_COLORS.accentMuted
                      : selected
                        ? FIELDS_COLORS.accentMuted
                        : blocked
                          ? FIELDS_COLORS.dangerMuted
                          : FIELDS_COLORS.surfaceSolid,
                    borderBottomWidth: 1,
                    borderBottomColor: FIELDS_COLORS.panelBorder,
                    borderLeftWidth: 3,
                    borderLeftColor: selected ? FIELDS_COLORS.accentBrand : "transparent",
                    opacity: paint ? 1 : 0.5,
                  }}
                >
                  {/* Drag starts here only — see DRAG_HANDLE_WIDTH. Anywhere else on the
                      row belongs to the scroller. */}
                  <Pressable
                    onLongPress={drag}
                    delayLongPress={180}
                    disabled={isActive}
                    hitSlop={{ top: 8, bottom: 8, left: 10, right: 4 }}
                    style={{
                      width: 20,
                      alignSelf: "stretch",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    <GripVertical size={14} color={FIELDS_COLORS.textDim} />
                  </Pressable>
                  <Pressable
                    onPress={() => {
                      if (!onSelectLine) return;
                      const nextId = selected ? null : item.line.id;
                      onSelectLine(nextId, { highlightLineIds: null });
                    }}
                    style={{
                      flex: 1,
                      minWidth: 0,
                      flexDirection: "row",
                      alignItems: "center",
                      gap: 8,
                    }}
                  >
                    <View
                      style={{
                        width: 24,
                        height: 24,
                        borderRadius: 7,
                        alignItems: "center",
                        justifyContent: "center",
                        backgroundColor: paint
                          ? FIELDS_COLORS.accentMuted
                          : FIELDS_COLORS.panelSolid,
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
                    <Text
                      style={{
                        flex: 1,
                        minWidth: 0,
                        color: blocked ? FIELDS_COLORS.danger : FIELDS_COLORS.textMain,
                        fontSize: 13,
                        fontWeight: "600",
                      }}
                      numberOfLines={1}
                    >
                      {item.line.label}
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
                  </Pressable>
                  <Pressable
                    onPress={() => setOrder((prev) => setPathPaint(prev, item.line.id, !paint))}
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
              </ScaleDecorator>
            );
          }}
        />
      </View>
    </View>
  );
}
