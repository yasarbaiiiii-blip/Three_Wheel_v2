/**
 * Multi-select Start sheet for Mission Layers.
 * Matches Fields dark panel chrome (not the white password modal).
 */

import React, { useEffect, useState } from "react";
import { Modal, Pressable, Text, View } from "react-native";
import { Check, Layers } from "lucide-react-native";

import type { MissionLayer } from "../../types/missionLayers";
import { FIELDS_COLORS } from "./fieldsTheme";

export type MissionLayerStartModalProps = {
  visible: boolean;
  layers: MissionLayer[];
  unassignedCount: number;
  onConfirm: (selectedLayerIds: string[]) => void;
  onCancel: () => void;
};

export function MissionLayerStartModal({
  visible,
  layers,
  unassignedCount,
  onConfirm,
  onCancel,
}: MissionLayerStartModalProps) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set(layers.map((l) => l.id)));

  useEffect(() => {
    if (visible) {
      setSelected(new Set(layers.map((l) => l.id)));
    }
  }, [visible, layers]);

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const count = selected.size;
  const canStart = count > 0;

  return (
    <Modal transparent visible={visible} animationType="fade" onRequestClose={onCancel}>
      <Pressable
        onPress={onCancel}
        style={{
          flex: 1,
          backgroundColor: FIELDS_COLORS.overlay,
          alignItems: "center",
          justifyContent: "center",
          padding: 24,
        }}
      >
        <Pressable
          onPress={() => {}}
          style={{
            width: "100%",
            maxWidth: 420,
            borderRadius: 16,
            backgroundColor: FIELDS_COLORS.panelSolid,
            borderWidth: 1,
            borderColor: FIELDS_COLORS.panelBorder,
            padding: 18,
            gap: 14,
          }}
        >
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
            <View
              style={{
                width: 36,
                height: 36,
                borderRadius: 10,
                backgroundColor: FIELDS_COLORS.iconBrand,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Layers size={18} color={FIELDS_COLORS.accentBrand} strokeWidth={2.2} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ color: FIELDS_COLORS.textMain, fontSize: 17, fontWeight: "800" }}>
                Start mission layers
              </Text>
              <Text style={{ color: FIELDS_COLORS.textMuted, fontSize: 12, marginTop: 2 }}>
                Choose which mission layers to run. Entry path rebuilds from the rover&apos;s live pose.
              </Text>
            </View>
          </View>

          <View style={{ gap: 8 }}>
            {layers.map((layer) => {
              const on = selected.has(layer.id);
              const fileCount = layer.fileEntryIds.length;
              return (
                <Pressable
                  key={layer.id}
                  onPress={() => toggle(layer.id)}
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 12,
                    paddingVertical: 12,
                    paddingHorizontal: 12,
                    borderRadius: 12,
                    borderWidth: 1,
                    borderColor: on ? FIELDS_COLORS.accentBorder : FIELDS_COLORS.panelBorder,
                    backgroundColor: on ? FIELDS_COLORS.accentMuted : FIELDS_COLORS.surfaceSolid,
                  }}
                >
                  <View
                    style={{
                      width: 28,
                      height: 28,
                      borderRadius: 8,
                      alignItems: "center",
                      justifyContent: "center",
                      backgroundColor: on ? FIELDS_COLORS.accentBrand : FIELDS_COLORS.pillSecondary,
                    }}
                  >
                    <Text
                      style={{
                        color: on ? FIELDS_COLORS.accentText : FIELDS_COLORS.textMain,
                        fontWeight: "900",
                        fontSize: 13,
                      }}
                    >
                      {layer.number}
                    </Text>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={{ color: FIELDS_COLORS.textMain, fontWeight: "700", fontSize: 14 }}>
                      Mission Layer {layer.number}
                    </Text>
                    <Text style={{ color: FIELDS_COLORS.textDim, fontSize: 11, marginTop: 2 }}>
                      {fileCount} file{fileCount === 1 ? "" : "s"}
                      {layer.finished ? " · finished" : ""}
                      {layer.lastOutcome === "stopped" ? " · last run stopped" : ""}
                    </Text>
                  </View>
                  <View
                    style={{
                      width: 22,
                      height: 22,
                      borderRadius: 6,
                      borderWidth: 1.5,
                      borderColor: on ? FIELDS_COLORS.accentBrand : FIELDS_COLORS.textDim,
                      backgroundColor: on ? FIELDS_COLORS.accentBrand : "transparent",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    {on ? <Check size={14} color={FIELDS_COLORS.accentText} strokeWidth={3} /> : null}
                  </View>
                </Pressable>
              );
            })}
          </View>

          {unassignedCount > 0 ? (
            <Text style={{ color: FIELDS_COLORS.warning, fontSize: 12, lineHeight: 17 }}>
              {unassignedCount} file{unassignedCount === 1 ? "" : "s"} not in any mission layer — will not
              run. Use Control to assign them.
            </Text>
          ) : null}

          {!canStart ? (
            <Text style={{ color: FIELDS_COLORS.danger, fontSize: 12 }}>
              Select at least one mission layer to start.
            </Text>
          ) : null}

          <View style={{ flexDirection: "row", gap: 10, marginTop: 4 }}>
            <Pressable
              onPress={onCancel}
              style={{
                flex: 1,
                height: 42,
                borderRadius: 12,
                alignItems: "center",
                justifyContent: "center",
                borderWidth: 1,
                borderColor: FIELDS_COLORS.panelBorder,
                backgroundColor: FIELDS_COLORS.surfaceSolid,
              }}
            >
              <Text style={{ color: FIELDS_COLORS.textMuted, fontWeight: "700" }}>Cancel</Text>
            </Pressable>
            <Pressable
              onPress={() => {
                if (!canStart) return;
                onConfirm([...selected]);
              }}
              disabled={!canStart}
              style={{
                flex: 1,
                height: 42,
                borderRadius: 12,
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: canStart ? FIELDS_COLORS.accentBrand : FIELDS_COLORS.pillSecondary,
                opacity: canStart ? 1 : 0.55,
              }}
            >
              <Text
                style={{
                  color: canStart ? FIELDS_COLORS.accentText : FIELDS_COLORS.textDim,
                  fontWeight: "800",
                }}
              >
                Start{count > 0 ? ` (${count})` : ""}
              </Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
