import React, { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { Check, ChevronDown, LayoutGrid, MapPin } from "lucide-react-native";

import { FIELDS_COLORS } from "../fieldsTheme";
import { TemplateLibraryGallery, type LibraryDraft } from "../TemplateLibraryGallery";

export type PlacedTemplateSummary = {
  id: string;
  fileName: string;
};

type TemplatePanelProps = {
  apiBaseUrl: string;
  onRefreshPaths: () => void;
  onSelectPath: (name: string) => void;
  canPlace?: boolean;
  placeBlockedReason?: string | null;
  session?: "idle" | "picking" | "ghost";
  selectedLabel?: string | null;
  selectedTemplateId?: string | null;
  dragEnabled?: boolean;
  scaleEnabled?: boolean;
  rotateEnabled?: boolean;
  onBeginPlace?: (draft: LibraryDraft) => void;
  onCancelPlace?: () => void;
  onConfirmPlace?: () => void;
  onToggleDrag?: () => void;
  onToggleScale?: () => void;
  onToggleRotate?: () => void;
  onRemoveSelected?: () => void;
  placedTemplates?: PlacedTemplateSummary[];
  onSelectPlacedTemplate?: (id: string) => void;
};

function PlacedTemplatesDropdown({
  templates,
  selectedId,
  onSelect,
}: {
  templates: PlacedTemplateSummary[];
  selectedId: string | null | undefined;
  onSelect: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  if (templates.length === 0) return null;
  const selected = templates.find((t) => t.id === selectedId);
  const accent = "#8b5cf6";

  return (
    <View style={{ zIndex: 30 }}>
      <Text
        style={{
          color: FIELDS_COLORS.textDim,
          fontSize: 10,
          fontWeight: "800",
          letterSpacing: 0.6,
          marginBottom: 6,
          textTransform: "uppercase",
        }}
      >
        Edit template
      </Text>
      <Pressable
        onPress={() => setOpen((o) => !o)}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        style={{
          minHeight: 44,
          borderRadius: 10,
          borderWidth: 1.5,
          borderColor: open ? accent : FIELDS_COLORS.panelBorder,
          backgroundColor: FIELDS_COLORS.surfaceSolid,
          paddingHorizontal: 12,
          flexDirection: "row",
          alignItems: "center",
          gap: 10,
        }}
      >
        <MapPin size={14} color={accent} />
        <Text style={{ flex: 1, color: FIELDS_COLORS.textMain, fontSize: 13, fontWeight: "700" }} numberOfLines={1}>
          {selected?.fileName ?? "Choose a placed template"}
        </Text>
        <View style={{ transform: [{ rotate: open ? "180deg" : "0deg" }] }}>
          <ChevronDown size={16} color={FIELDS_COLORS.textMuted} />
        </View>
      </Pressable>
      {open ? (
        <View
          style={{
            marginTop: 6,
            borderRadius: 10,
            borderWidth: 1,
            borderColor: FIELDS_COLORS.panelBorder,
            backgroundColor: FIELDS_COLORS.cardSolid,
            overflow: "hidden",
          }}
        >
          {templates.map((tpl, index) => {
            const isSelected = tpl.id === selectedId;
            return (
              <Pressable
                key={tpl.id}
                onPress={() => {
                  setOpen(false);
                  onSelect(tpl.id);
                }}
                style={{
                  paddingHorizontal: 12,
                  paddingVertical: 10,
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 10,
                  backgroundColor: isSelected ? "rgba(139,92,246,0.12)" : "transparent",
                  borderTopWidth: index === 0 ? 0 : 1,
                  borderTopColor: FIELDS_COLORS.panelBorder,
                }}
              >
                <Text
                  style={{
                    flex: 1,
                    color: isSelected ? FIELDS_COLORS.textMain : FIELDS_COLORS.textMuted,
                    fontSize: 13,
                    fontWeight: isSelected ? "800" : "600",
                  }}
                  numberOfLines={1}
                >
                  {tpl.fileName}
                </Text>
                {isSelected ? <Check size={15} color={accent} strokeWidth={2.5} /> : null}
              </Pressable>
            );
          })}
        </View>
      ) : null}
    </View>
  );
}

function ToolBtn({
  label,
  active,
  disabled,
  onPress,
}: {
  label: string;
  active: boolean;
  disabled: boolean;
  onPress?: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ disabled, selected: active }}
      style={{
        flex: 1,
        height: 40,
        borderRadius: 10,
        alignItems: "center",
        justifyContent: "center",
        borderWidth: 1.5,
        backgroundColor: active ? FIELDS_COLORS.accentBrand : FIELDS_COLORS.surfaceSolid,
        borderColor: active ? FIELDS_COLORS.accentBorder : FIELDS_COLORS.panelBorder,
        opacity: disabled ? 0.4 : 1,
      }}
    >
      <Text style={{ color: active ? "#18181b" : FIELDS_COLORS.textMuted, fontSize: 12, fontWeight: "800" }}>
        {label}
      </Text>
    </Pressable>
  );
}

export function TemplatePanel(props: TemplatePanelProps) {
  const [libraryOpen, setLibraryOpen] = useState(false);
  const placed = props.placedTemplates ?? [];
  const hasSelection = Boolean(props.selectedLabel);
  const placing = props.session === "picking" || props.session === "ghost";

  return (
    <View style={{ gap: 12 }}>
      <Pressable
        onPress={() => setLibraryOpen(true)}
        disabled={placing}
        accessibilityRole="button"
        style={{
          minHeight: 56,
          borderRadius: 16,
          flexDirection: "row",
          alignItems: "center",
          paddingHorizontal: 16,
          gap: 12,
          backgroundColor: FIELDS_COLORS.cardSolid,
          borderWidth: 1,
          borderColor: FIELDS_COLORS.panelBorder,
          opacity: placing ? 0.45 : 1,
        }}
      >
        <View
          style={{
            width: 36,
            height: 36,
            borderRadius: 10,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: "rgba(244,193,12,0.12)",
          }}
        >
          <LayoutGrid size={16} color={FIELDS_COLORS.accentBrand} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={{ color: FIELDS_COLORS.textMain, fontSize: 14, fontWeight: "800" }}>Library</Text>
          <Text style={{ color: FIELDS_COLORS.textDim, fontSize: 11, fontWeight: "600", marginTop: 1 }}>
            Signs and text
          </Text>
        </View>
      </Pressable>

      {props.session === "picking" ? (
        <View
          style={{
            borderRadius: 10,
            padding: 10,
            backgroundColor: "rgba(244,193,12,0.10)",
            borderWidth: 1,
            borderColor: FIELDS_COLORS.accentBorder,
          }}
        >
          <Text style={{ color: FIELDS_COLORS.accentBrand, fontSize: 12, fontWeight: "700" }}>
            Tap the map to place a ghost preview.
          </Text>
        </View>
      ) : null}
      {props.session === "ghost" ? (
        <View
          style={{
            borderRadius: 10,
            padding: 10,
            backgroundColor: "rgba(244,193,12,0.10)",
            borderWidth: 1,
            borderColor: FIELDS_COLORS.accentBorder,
          }}
        >
          <Text style={{ color: FIELDS_COLORS.accentBrand, fontSize: 12, fontWeight: "700" }}>
            Ghost is on the map. Place it, or tap again to move.
          </Text>
        </View>
      ) : null}

      {placing ? (
        <View style={{ flexDirection: "row", gap: 8 }}>
          <Pressable
            onPress={props.onCancelPlace}
            style={{
              flex: 1,
              height: 44,
              borderRadius: 10,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: FIELDS_COLORS.surfaceSolid,
              borderWidth: 1.5,
              borderColor: FIELDS_COLORS.panelBorder,
            }}
          >
            <Text style={{ color: FIELDS_COLORS.textMain, fontWeight: "800" }}>Cancel</Text>
          </Pressable>
          {props.session === "ghost" ? (
            <Pressable
              onPress={props.onConfirmPlace}
              style={{
                flex: 1,
                height: 44,
                borderRadius: 10,
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: FIELDS_COLORS.teal,
              }}
            >
              <Text style={{ color: "#fff", fontWeight: "800" }}>Place</Text>
            </Pressable>
          ) : (
            <View
              style={{
                flex: 1,
                height: 44,
                borderRadius: 10,
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: FIELDS_COLORS.pillSecondary,
              }}
            >
              <Text style={{ color: FIELDS_COLORS.textMuted, fontWeight: "800" }}>Tap map</Text>
            </View>
          )}
        </View>
      ) : null}

      <PlacedTemplatesDropdown
        templates={placed}
        selectedId={props.selectedTemplateId}
        onSelect={(id) => props.onSelectPlacedTemplate?.(id)}
      />

      <View style={{ gap: 8 }}>
        <Text style={{ color: FIELDS_COLORS.textDim, fontSize: 10, fontWeight: "800", letterSpacing: 0.6 }}>
          TRANSFORM
        </Text>
        <View style={{ flexDirection: "row", gap: 6 }}>
          <ToolBtn label="Drag" active={!!props.dragEnabled} disabled={!hasSelection} onPress={props.onToggleDrag} />
          <ToolBtn label="Scale" active={!!props.scaleEnabled} disabled={!hasSelection} onPress={props.onToggleScale} />
          <ToolBtn label="Rotate" active={!!props.rotateEnabled} disabled={!hasSelection} onPress={props.onToggleRotate} />
        </View>
        {hasSelection && props.onRemoveSelected ? (
          <Pressable
            onPress={props.onRemoveSelected}
            style={{
              height: 36,
              borderRadius: 10,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: FIELDS_COLORS.dangerMuted,
              borderWidth: 1,
              borderColor: FIELDS_COLORS.dangerBorder,
            }}
          >
            <Text style={{ color: FIELDS_COLORS.danger, fontSize: 12, fontWeight: "800" }}>Remove</Text>
          </Pressable>
        ) : null}
      </View>

      <TemplateLibraryGallery
        visible={libraryOpen}
        onClose={() => setLibraryOpen(false)}
        canPlace={props.canPlace}
        placeBlockedReason={props.placeBlockedReason}
        onAdd={(draft) => {
          setLibraryOpen(false);
          props.onBeginPlace?.(draft);
        }}
      />
    </View>
  );
}
