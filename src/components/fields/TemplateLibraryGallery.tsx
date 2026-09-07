import React, { memo, useCallback, useMemo, useState } from "react";
import {
  Alert,
  FlatList,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  TouchableOpacity,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
  type ListRenderItem,
} from "react-native";
import { Gesture, GestureDetector, GestureHandlerRootView } from "react-native-gesture-handler";
import Animated, {
  interpolate,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { SafeAreaProvider, useSafeAreaInsets } from "react-native-safe-area-context";
import { AlertTriangle, Lock, Minus, Plus, RotateCcw, RotateCw, X } from "lucide-react-native";

import type { PlanLine } from "../../types/plan";
import { generateTextLines, type FontStyle } from "../../utils/characterTemplates";
import { generateRoadSignLines, ROAD_SIGN_LABELS, type RoadSignType } from "../../utils/roadSignTemplates";
import { FIELDS_COLORS } from "./fieldsTheme";
import { RoadSignThumbnail } from "./RoadSignThumbnail";
import { CHAR_CATALOG, SIGN_CATALOG, type CatalogItem } from "./templateLibraryCatalog";
import { PreviewDimensionOverlay } from "./PreviewDimensionOverlay";
import { TemplateLinePreview } from "./TemplateLinePreview";

type GalleryCategory = "signs" | "characters";

export type LibraryDraft = {
  kind: "sign" | "characters";
  fileName: string;
  sourceLines: PlanLine[];
};

type TemplateLibraryGalleryProps = {
  visible: boolean;
  onClose: () => void;
  onAdd: (draft: LibraryDraft) => void;
  canPlace?: boolean;
  placeBlockedReason?: string | null;
};

const SIZE_PRESETS = [1, 3, 5, 7, 9];
const SIZE_MIN = 0.5;
const SIZE_MAX = 12;
const SIZE_STEP = 0.5;
const GOLD = FIELDS_COLORS.accentBrand;
const GRID_GAP = 10;

function clampSize(n: number) {
  const snapped = Math.round(n / SIZE_STEP) * SIZE_STEP;
  return Math.min(SIZE_MAX, Math.max(SIZE_MIN, Number(snapped.toFixed(1))));
}

function rotatePlanLines(lines: PlanLine[], deg: number): PlanLine[] {
  if (!Number.isFinite(deg) || Math.abs(deg) < 0.05) return lines;
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (const line of lines) {
    sx += line.from.x + line.to.x;
    sy += line.from.y + line.to.y;
    n += 2;
  }
  if (n === 0) return lines;
  const cx = sx / n;
  const cy = sy / n;
  const rad = (deg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const spin = (x: number, y: number) => ({
    x: cx + (x - cx) * cos - (y - cy) * sin,
    y: cy + (x - cx) * sin + (y - cy) * cos,
  });
  return lines.map((line) => {
    const a = spin(line.from.x, line.from.y);
    const b = spin(line.to.x, line.to.y);
    const preview = line.entity?.preview_points?.map((p) => {
      const next = spin(p.north, p.east);
      return { ...p, north: next.x, east: next.y };
    });
    return {
      ...line,
      from: { ...line.from, x: a.x, y: a.y },
      to: { ...line.to, x: b.x, y: b.y },
      entity: line.entity ? { ...line.entity, preview_points: preview ?? line.entity.preview_points } : line.entity,
    };
  });
}

const CatalogTile = memo(function CatalogTile({
  item,
  category,
  active,
  sizeM,
  fontStyle,
  onPress,
  onAdd,
}: {
  item: CatalogItem;
  category: GalleryCategory;
  active: boolean;
  sizeM: number;
  fontStyle: FontStyle;
  onPress: (item: CatalogItem) => void;
  onAdd?: () => void;
}) {
  const dim = `${(item.widthM * sizeM).toFixed(2)} × ${(item.heightM * sizeM).toFixed(2)} m`;
  return (
    <Pressable
      onPress={() => onPress(item)}
      accessibilityRole="button"
      accessibilityLabel={`${item.label}, ${dim}`}
      accessibilityState={{ selected: active }}
      style={({ pressed }) => [
        styles.card,
        active ? styles.cardOn : styles.cardOff,
        pressed && { opacity: 0.88, transform: [{ scale: 0.98 }] },
      ]}
    >
      <View style={[styles.templatePreviewBox, active ? styles.templatePreviewBoxOn : styles.templatePreviewBoxOff]}>
        {category === "signs" ? (
          <RoadSignThumbnail sign={item.id as RoadSignType} size={124} strokeWidth={0.024} stroke={active ? GOLD : "#f4f4f5"} bare />
        ) : (
          <Text
            style={[
              styles.glyph,
              { fontSize: 82, color: active ? GOLD : "#f4f4f5" },
              fontStyle === "stencil" && styles.glyphStencil,
            ]}
          >
            {item.label}
          </Text>
        )}
      </View>
      <View style={styles.cardFooter}>
        <Text style={[styles.cardName, active && styles.cardNameOn]} numberOfLines={1}>
          {item.label}
        </Text>
        <Text style={[styles.cardDim, active && styles.cardDimOn]} numberOfLines={1}>
          {dim}
        </Text>
        {active && onAdd ? (
          <TouchableOpacity
            onPress={(e) => {
              e?.stopPropagation?.();
              onAdd();
            }}
            accessibilityRole="button"
            accessibilityLabel={`Add ${item.label} to map`}
            style={styles.tileAddBtnOn}
            activeOpacity={0.8}
          >
            <Plus size={14} color="#000000" strokeWidth={3} />
            <Text style={styles.tileAddTextOn}>Add</Text>
          </TouchableOpacity>
        ) : null}
      </View>
    </Pressable>
  );
});

export function TemplateLibraryGallery(props: TemplateLibraryGalleryProps) {
  return (
    <Modal
      visible={props.visible}
      animationType="fade"
      presentationStyle="fullScreen"
      statusBarTranslucent
      onRequestClose={props.onClose}
    >
      {props.visible ? (
        <SafeAreaProvider>
          <LibraryBody {...props} />
        </SafeAreaProvider>
      ) : null}
    </Modal>
  );
}

function LibraryBody({
  onClose,
  onAdd,
  canPlace = true,
  placeBlockedReason,
}: TemplateLibraryGalleryProps) {
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const split = width >= 780;

  const [category, setCategory] = useState<GalleryCategory>("signs");
  const [sign, setSign] = useState<RoadSignType>("am_01");
  const [glyph, setGlyph] = useState("A");
  const [customText, setCustomText] = useState("");
  const [fontStyle, setFontStyle] = useState<FontStyle>("smooth");
  const [sizeM, setSizeM] = useState(1);
  const [rotDeg, setRotDeg] = useState(0);
  const [stage, setStage] = useState({ w: Math.round(width * 0.5), h: Math.round(height * 0.48) });
  const [segW, setSegW] = useState(0);

  const zoomSv = useSharedValue(1);
  const panXSv = useSharedValue(0);
  const panYSv = useSharedValue(0);
  const rotSv = useSharedValue(0);
  const pinch0 = useSharedValue(1);
  const pan0x = useSharedValue(0);
  const pan0y = useSharedValue(0);
  const rot0 = useSharedValue(0);
  const tabSv = useSharedValue(0);
  const [listW, setListW] = useState(0);

  const characterSource = (customText.trim() || glyph || "A").toUpperCase();

  const previewLines = useMemo(() => {
    if (category === "characters") return generateTextLines(characterSource, sizeM, fontStyle, 0.12);
    return generateRoadSignLines(sign, sizeM);
  }, [category, sign, characterSource, fontStyle, sizeM]);

  const fileName = useMemo(() => {
    if (category === "characters") return `Text ${characterSource} ${sizeM.toFixed(1)}m`;
    return `${ROAD_SIGN_LABELS[sign]} ${sizeM.toFixed(1)}m`;
  }, [category, sign, characterSource, sizeM]);

  const displayName = category === "characters" ? characterSource : ROAD_SIGN_LABELS[sign];

  const filmData = category === "signs" ? SIGN_CATALOG : CHAR_CATALOG;
  const selectedId = category === "signs" ? sign : customText.trim() ? "" : glyph;

  const catalogW = split ? Math.min(500, Math.max(360, Math.round(width * 0.40))) : width - 32;

  const resetView = useCallback(() => {
    zoomSv.value = withTiming(1, { duration: 180 });
    panXSv.value = withTiming(0, { duration: 180 });
    panYSv.value = withTiming(0, { duration: 180 });
    rotSv.value = withTiming(0, { duration: 180 });
    setRotDeg(0);
  }, [zoomSv, panXSv, panYSv, rotSv]);

  const snapRotate = (delta: number) => {
    const next = rotDeg + delta;
    rotSv.value = withSpring(next, { damping: 16, stiffness: 180 });
    setRotDeg(next);
  };

  const pinch = useMemo(
    () =>
      Gesture.Pinch()
        .onBegin(() => {
          pinch0.value = zoomSv.value;
        })
        .onUpdate((e) => {
          const next = pinch0.value * e.scale;
          // Clamp inline — calling JS helpers from this worklet crashes the app.
          zoomSv.value = Math.min(4, Math.max(0.7, next));
        }),
    [pinch0, zoomSv]
  );
  const drag = useMemo(
    () =>
      Gesture.Pan()
        .maxPointers(1)
        .minDistance(8)
        .onBegin(() => {
          pan0x.value = panXSv.value;
          pan0y.value = panYSv.value;
        })
        .onUpdate((e) => {
          panXSv.value = pan0x.value + e.translationX;
          panYSv.value = pan0y.value + e.translationY;
        }),
    [pan0x, pan0y, panXSv, panYSv]
  );
  const twist = useMemo(
    () =>
      Gesture.Rotation()
        .onBegin(() => {
          rot0.value = rotSv.value;
        })
        .onUpdate((e) => {
          rotSv.value = rot0.value + (e.rotation * 180) / Math.PI;
        })
        .onEnd(() => {
          runOnJS(setRotDeg)(rotSv.value);
        }),
    [rot0, rotSv]
  );
  const doubleTap = useMemo(
    () =>
      Gesture.Tap()
        .numberOfTaps(2)
        .onEnd(() => {
          runOnJS(resetView)();
        }),
    [resetView]
  );
  const previewGesture = useMemo(
    () => Gesture.Simultaneous(pinch, drag, twist, doubleTap),
    [pinch, drag, twist, doubleTap]
  );

  const previewAnimStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: panXSv.value },
      { translateY: panYSv.value },
      { rotate: `${rotSv.value}deg` },
      { scale: zoomSv.value },
    ],
  }));

  const tabPillStyle = useAnimatedStyle(() => {
    const inner = Math.max(0, (segW - 6) / 2);
    return {
      transform: [{ translateX: interpolate(tabSv.value, [0, 1], [0, inner]) }],
      width: inner,
    };
  });

  const handleAdd = () => {
    if (!canPlace) {
      Alert.alert(
        "Cannot Place Yet",
        placeBlockedReason || "Please import a survey or align a plan first so the template has a map frame."
      );
      return;
    }
    if (previewLines.length === 0) return;
    onAdd({
      kind: category === "characters" ? "characters" : "sign",
      fileName,
      sourceLines: rotatePlanLines(previewLines, rotSv.value),
    });
  };

  const selectFilm = useCallback(
    (item: CatalogItem) => {
      Keyboard.dismiss();
      if (category === "signs") {
        setSign(item.id as RoadSignType);
        resetView();
        return;
      }
      setGlyph(item.id);
      setCustomText("");
      resetView();
    },
    [category, resetView]
  );

  const switchCategory = (next: GalleryCategory) => {
    setCategory(next);
    tabSv.value = withSpring(next === "signs" ? 0 : 1, { damping: 18, stiffness: 220, mass: 0.7 });
    resetView();
  };

  const addLocked = !canPlace || previewLines.length === 0;

  const renderItem = useCallback<ListRenderItem<CatalogItem>>(
    ({ item }) => (
      <View style={styles.tileWrapper}>
        <CatalogTile
          item={item}
          category={category}
          active={item.id === selectedId}
          sizeM={sizeM}
          fontStyle={fontStyle}
          onPress={selectFilm}
          onAdd={addLocked ? undefined : handleAdd}
        />
      </View>
    ),
    [addLocked, category, fontStyle, handleAdd, selectFilm, selectedId, sizeM]
  );

  const displayAngle = ((rotDeg % 360) + 360) % 360;
  const previewArt = Math.max(160, Math.min(stage.w - 8, stage.h - 72));
  const topPad = Math.max(insets.top, StatusBar.currentHeight ?? 0, 12);

  const sizeHud = (
    <View style={styles.sizeHud} pointerEvents="box-none">
      <Pressable
        onPress={() => setSizeM((v) => clampSize(v - SIZE_STEP))}
        accessibilityLabel="Smaller"
        style={styles.sizeHudBtn}
      >
        <Minus size={14} color={FIELDS_COLORS.textMain} />
      </Pressable>
      <Text style={styles.sizeHudValue}>{sizeM.toFixed(1)} m</Text>
      <Pressable
        onPress={() => setSizeM((v) => clampSize(v + SIZE_STEP))}
        accessibilityLabel="Larger"
        style={styles.sizeHudBtn}
      >
        <Plus size={14} color={FIELDS_COLORS.textMain} />
      </Pressable>
      <View style={styles.sizeHudPresets}>
        {SIZE_PRESETS.map((preset) => {
          const on = Math.abs(sizeM - preset) < 0.05;
          return (
            <Pressable key={preset} onPress={() => setSizeM(preset)} style={[styles.sizeChip, on && styles.sizeChipOn]}>
              <Text style={[styles.sizeChipText, on && styles.sizeChipTextOn]}>{preset}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );

  return (
    <GestureHandlerRootView style={styles.root}>
      <StatusBar barStyle="light-content" backgroundColor={FIELDS_COLORS.bgBase} />
      <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <View style={[styles.topBar, { paddingTop: topPad }]}>
          <View style={{ flex: 1 }}>
            <Text style={styles.kicker}>Library</Text>
            <Text style={styles.title} numberOfLines={1}>
              {displayName}
            </Text>
          </View>
          <View style={styles.topRightActions}>
            <TouchableOpacity
              onPress={handleAdd}
              accessibilityRole="button"
              style={styles.topAddBtn}
              activeOpacity={0.8}
            >
              <Plus size={18} color="#09090b" strokeWidth={3} />
              <Text style={styles.topAddText}>Add to Map</Text>
            </TouchableOpacity>
            <Pressable
              onPress={onClose}
              accessibilityRole="button"
              accessibilityLabel="Close library"
              hitSlop={8}
              style={({ pressed }) => [
                styles.closeBtn,
                pressed && { opacity: 0.75, transform: [{ scale: 0.96 }] },
              ]}
            >
              <X size={18} color={FIELDS_COLORS.textMain} />
            </Pressable>
          </View>
        </View>

        <View
          style={[
            split ? styles.split : styles.stack,
            { paddingBottom: Math.max(insets.bottom, 10) },
          ]}
        >
          <View
            style={styles.stageCard}
            onLayout={(e) => {
              const { width: w, height: h } = e.nativeEvent.layout;
              if (w > 0 && h > 0 && (Math.abs(w - stage.w) > 2 || Math.abs(h - stage.h) > 2)) {
                setStage({ w, h });
              }
            }}
          >
            <View pointerEvents="none" style={styles.spot} />
            <GestureDetector gesture={previewGesture}>
              <Animated.View style={[styles.stageHit, previewAnimStyle]}>
                <View style={{ width: Math.max(140, previewArt), height: Math.max(140, previewArt) }}>
                  <TemplateLinePreview
                    lines={previewLines}
                    size={Math.max(140, previewArt)}
                    zoom={1}
                    stroke={GOLD}
                    strokePx={1.25}
                    showDimensions={false}
                    horizontal={false}
                  />
                  <PreviewDimensionOverlay
                    lines={previewLines}
                    size={Math.max(140, previewArt)}
                    zoomSv={zoomSv}
                  />
                </View>
              </Animated.View>
            </GestureDetector>
            {sizeHud}
            <View style={styles.rotateBar}>
              <Pressable onPress={() => snapRotate(-90)} accessibilityLabel="Rotate left 90" style={styles.rotateBtn}>
                <RotateCcw size={16} color={FIELDS_COLORS.textMain} />
              </Pressable>
              <Text style={styles.rotateDeg}>{displayAngle.toFixed(0)}°</Text>
              <Pressable onPress={() => snapRotate(90)} accessibilityLabel="Rotate right 90" style={styles.rotateBtn}>
                <RotateCw size={16} color={FIELDS_COLORS.textMain} />
              </Pressable>
              <Pressable onPress={resetView} accessibilityLabel="Reset view" style={styles.rotateBtn}>
                <Text style={styles.resetLabel}>reset</Text>
              </Pressable>
            </View>

            <TouchableOpacity
              onPress={handleAdd}
              accessibilityRole="button"
              accessibilityLabel="Add to Map"
              style={styles.stageMainAddBtn}
              activeOpacity={0.8}
            >
              <Plus size={20} color="#000000" strokeWidth={3.2} />
              <Text style={styles.stageMainAddText}>Add to Map</Text>
            </TouchableOpacity>
          </View>

          <View style={[styles.rail, split ? { width: catalogW, flex: 0 } : styles.dock]}>
            <View onLayout={(e) => setSegW(e.nativeEvent.layout.width)} style={styles.seg}>
              <Animated.View style={[styles.segPill, tabPillStyle]} />
              {(
                [
                  { id: "signs" as const, label: "Signs" },
                  { id: "characters" as const, label: "Text" },
                ] as const
              ).map((c) => {
                const active = category === c.id;
                return (
                  <Pressable
                    key={c.id}
                    onPress={() => switchCategory(c.id)}
                    style={styles.segBtn}
                    accessibilityRole="tab"
                    accessibilityState={{ selected: active }}
                  >
                    <Text style={[styles.segLabel, active && styles.segLabelOn]}>{c.label}</Text>
                  </Pressable>
                );
              })}
            </View>

            {addLocked && placeBlockedReason ? (
              <View style={styles.blockedBanner}>
                <AlertTriangle size={14} color={FIELDS_COLORS.warning} style={{ flexShrink: 0 }} />
                <Text style={styles.blockedText}>{placeBlockedReason}</Text>
              </View>
            ) : null}


            {category === "characters" ? (
              <View style={styles.wordRow}>
                <TextInput
                  value={customText}
                  onChangeText={setCustomText}
                  autoCapitalize="characters"
                  autoCorrect={false}
                  placeholder="Type a word"
                  placeholderTextColor={FIELDS_COLORS.textDim}
                  style={styles.wordInput}
                />
                {(["smooth", "stencil"] as FontStyle[]).map((style) => (
                  <Pressable
                    key={style}
                    onPress={() => setFontStyle(style)}
                    style={[styles.fontChip, fontStyle === style && styles.fontChipOn]}
                  >
                    <Text style={[styles.fontLabel, fontStyle === style && styles.fontLabelOn]}>
                      {style === "smooth" ? "Sans" : "Stencil"}
                    </Text>
                  </Pressable>
                ))}
              </View>
            ) : null}

            <FlatList
              key={`${category}-2`}
              data={filmData}
              extraData={`${selectedId}:${fontStyle}:${sizeM}`}
              keyExtractor={(item) => item.id}
              numColumns={2}
              columnWrapperStyle={styles.columnWrapper}
              contentContainerStyle={styles.listContent}
              renderItem={renderItem}
              style={styles.listFlex}
              showsVerticalScrollIndicator={true}
              keyboardShouldPersistTaps="handled"
              initialNumToRender={8}
              maxToRenderPerBatch={8}
              windowSize={5}
              removeClippedSubviews
              ListEmptyComponent={<Text style={styles.empty}>No templates in this set.</Text>}
            />
            
            {!addLocked ? (
              <View style={{ position: "absolute", bottom: 16, left: 16, right: 16, zIndex: 10 }}>
                <TouchableOpacity
                  onPress={handleAdd}
                  accessibilityRole="button"
                  accessibilityLabel="Add to Map"
                  style={styles.railAddBtn}
                  activeOpacity={0.8}
                >
                  <Plus size={18} color="#09090b" strokeWidth={3} />
                  <Text style={styles.railAddText}>Add to Map</Text>
                </TouchableOpacity>
              </View>
            ) : null}
          </View>
        </View>
      </KeyboardAvoidingView>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: FIELDS_COLORS.bgBase },
  topBar: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 20,
    paddingBottom: 8,
    gap: 12,
  },
  kicker: {
    color: GOLD,
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 1.8,
    textTransform: "uppercase",
  },
  title: {
    color: FIELDS_COLORS.textMain,
    fontSize: 22,
    fontWeight: "800",
    letterSpacing: -0.4,
    marginTop: 2,
  },
  closeBtn: {
    width: 42,
    height: 42,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.08)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.12)",
  },
  split: {
    flex: 1,
    flexDirection: "row",
    paddingHorizontal: 16,
    gap: 16,
    minHeight: 0,
  },
  stack: {
    flex: 1,
    minHeight: 0,
    paddingHorizontal: 16,
    gap: 10,
  },
  rail: {
    gap: 10,
    minHeight: 0,
    alignSelf: "stretch",
  },
  dock: {
    flex: 1,
    minHeight: 0,
    paddingTop: 12,
    paddingHorizontal: 4,
    gap: 10,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    backgroundColor: "#101014",
    borderTopWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.08)",
  },
  stageCard: {
    flex: 1.2,
    minHeight: 0,
    borderRadius: 28,
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#0c0c0f",
    borderWidth: 1,
    borderColor: "rgba(244,193,12,0.18)",
  },
  stageHit: {
    flex: 1,
    alignSelf: "stretch",
    alignItems: "center",
    justifyContent: "center",
  },
  spot: {
    position: "absolute",
    width: 220,
    height: 220,
    borderRadius: 110,
    backgroundColor: "rgba(244,193,12,0.06)",
  },
  dimHud: {
    position: "absolute",
    top: 12,
    left: 14,
  },
  dimHudText: { color: GOLD, fontSize: 11, fontWeight: "800", letterSpacing: 0.3 },
  sizeHud: {
    position: "absolute",
    top: 8,
    right: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 6,
    paddingVertical: 4,
    borderRadius: 16,
    backgroundColor: "rgba(9,9,11,0.78)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
  },
  sizeHudBtn: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  sizeHudValue: {
    color: FIELDS_COLORS.textMain,
    fontSize: 13,
    fontWeight: "800",
    minWidth: 48,
    textAlign: "center",
    fontVariant: ["tabular-nums"],
  },
  sizeHudPresets: { flexDirection: "row", gap: 4, marginLeft: 4 },
  sizeChip: {
    minWidth: 26,
    height: 24,
    paddingHorizontal: 6,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.06)",
  },
  sizeChipOn: { backgroundColor: GOLD },
  sizeChipText: { color: FIELDS_COLORS.textMuted, fontSize: 11, fontWeight: "800" },
  sizeChipTextOn: { color: FIELDS_COLORS.accentText },
  rotateBar: {
    position: "absolute",
    bottom: 16,
    left: 16,
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    height: 48,
    borderRadius: 24,
    backgroundColor: "rgba(18, 18, 24, 0.92)",
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.16)",
    zIndex: 999,
    elevation: 20,
  },
  rotateBtn: { width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center" },
  rotateDeg: {
    color: FIELDS_COLORS.textMain,
    fontSize: 13,
    fontWeight: "800",
    minWidth: 38,
    textAlign: "center",
    fontVariant: ["tabular-nums"],
  },
  resetLabel: {
    color: FIELDS_COLORS.textMuted,
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 0.5,
    textTransform: "uppercase",
  },
  seg: {
    alignSelf: "stretch",
    height: 38,
    borderRadius: 19,
    backgroundColor: "rgba(255,255,255,0.05)",
    flexDirection: "row",
    padding: 3,
  },
  segPill: {
    position: "absolute",
    top: 3,
    left: 3,
    bottom: 3,
    borderRadius: 16,
    backgroundColor: "rgba(244,193,12,0.16)",
  },
  segBtn: { flex: 1, alignItems: "center", justifyContent: "center", zIndex: 1 },
  segLabel: { color: FIELDS_COLORS.textDim, fontSize: 13, fontWeight: "700" },
  segLabelOn: { color: GOLD },
  wordRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  wordInput: {
    flex: 1,
    height: 42,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.1)",
    backgroundColor: "#18181c",
    color: FIELDS_COLORS.textMain,
    fontSize: 15,
    fontWeight: "700",
    letterSpacing: 1.4,
    paddingHorizontal: 12,
  },
  fontChip: {
    height: 42,
    paddingHorizontal: 12,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#18181c",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.1)",
  },
  fontChipOn: { borderColor: GOLD, backgroundColor: "rgba(244,193,12,0.1)" },
  fontLabel: { color: FIELDS_COLORS.textMuted, fontSize: 11, fontWeight: "800" },
  fontLabelOn: { color: GOLD },
  listFlex: { flex: 1, minHeight: 0 },
  listContent: { paddingBottom: 80 },
  columnWrapper: {
    gap: 10,
    justifyContent: "space-between",
    marginBottom: 10,
  },
  tileWrapper: {
    flex: 1,
    minWidth: 0,
  },
  empty: { color: FIELDS_COLORS.textMuted, textAlign: "center", paddingVertical: 24, fontWeight: "600" },
  card: {
    width: "100%",
    borderRadius: 12,
    padding: 4,
    borderWidth: 1.5,
    alignItems: "center",
    justifyContent: "space-between",
  },
  cardOff: {
    borderColor: "rgba(255, 255, 255, 0.12)",
    backgroundColor: "#20212a",
  },
  cardOn: {
    borderColor: GOLD,
    borderWidth: 1.5,
    backgroundColor: "#2a2518",
  },
  templatePreviewBox: {
    width: "100%",
    aspectRatio: 1.35,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
  },
  templatePreviewBoxOff: {
    backgroundColor: "#0d0e12",
    borderColor: "rgba(255, 255, 255, 0.08)",
  },
  templatePreviewBoxOn: {
    backgroundColor: "rgba(244, 193, 12, 0.10)",
    borderColor: "rgba(244, 193, 12, 0.35)",
  },
  cardFooter: {
    alignItems: "center",
    justifyContent: "center",
    width: "100%",
    paddingTop: 3,
    paddingBottom: 2,
  },
  cardName: {
    color: FIELDS_COLORS.textMain,
    fontSize: 13,
    fontWeight: "800",
    textAlign: "center",
    letterSpacing: 0.2,
  },
  cardNameOn: { color: GOLD },
  cardDim: {
    color: FIELDS_COLORS.textMuted,
    fontSize: 10,
    fontWeight: "600",
    marginTop: 2,
    textAlign: "center",
  },
  cardDimOn: {
    color: "#e4c66e",
  },
  glyph: { fontWeight: "500", includeFontPadding: false },
  glyphStencil: { letterSpacing: 1, fontWeight: "600" },
  tileAddBtnOn: {
    width: "100%",
    height: 34,
    borderRadius: 8,
    marginTop: 6,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    backgroundColor: "#f4c10c",
    borderWidth: 1,
    borderColor: "#ffffff",
  },
  tileAddTextOn: {
    color: "#000000",
    fontSize: 13,
    fontWeight: "900",
    letterSpacing: 0.3,
  },
  blockedBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 12,
    backgroundColor: "rgba(251, 191, 36, 0.10)",
    borderWidth: 1,
    borderColor: "rgba(251, 191, 36, 0.25)",
    flexShrink: 0,
  },
  blockedText: {
    flex: 1,
    color: FIELDS_COLORS.warning,
    fontSize: 11,
    fontWeight: "600",
    lineHeight: 15,
  },
  topRightActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  topAddBtn: {
    height: 42,
    paddingHorizontal: 20,
    borderRadius: 14,
    backgroundColor: GOLD,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: 8,
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.4)",
  },
  topAddText: {
    color: "#09090b",
    fontSize: 14,
    fontWeight: "800",
    letterSpacing: 0.2,
  },
  railAddBtn: {
    height: 44,
    borderRadius: 14,
    backgroundColor: GOLD,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: 8,
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.3)",
  },
  railAddText: {
    color: "#09090b",
    fontSize: 14,
    fontWeight: "800",
    letterSpacing: 0.2,
  },
  stageMainAddBtn: {
    position: "absolute",
    top: 16,
    left: 16,
    height: 48,
    paddingHorizontal: 24,
    borderRadius: 24,
    backgroundColor: "#f4c10c",
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: 8,
    borderWidth: 2,
    borderColor: "#ffffff",
    zIndex: 999,
  },
  stageMainAddText: {
    color: "#000000",
    fontSize: 15,
    fontWeight: "900",
    letterSpacing: 0.3,
  },
});
