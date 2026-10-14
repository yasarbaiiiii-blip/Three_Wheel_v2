/**
 * CSV point edit — select uploaded CSV points on the map, delete them from the working plan,
 * undo / redo, restore, reverse the plan, export the edited CSV. The original CSV is never changed.
 * (docs/CSV_POINT_EDIT_EXECUTION_PLAN.md)
 */
import React, { useState } from "react";
import { Modal, Pressable, Text, TextInput, View } from "react-native";
import {
  ArrowDownUp,
  Download,
  Pencil,
  Redo2,
  RotateCcw,
  Ruler,
  Trash2,
  Undo2,
  X,
} from "lucide-react-native";

import type { CsvPointEditApi } from "../../../hooks/useCsvPointEdit";
import { sanitizeExportBaseName } from "../../../utils/csvPointExport";
import { describeCsvEditStatus } from "../../../utils/csvPointEditStatus";
import { FIELDS_COLORS } from "../fieldsTheme";

type ActionProps = {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  tone?: "default" | "danger" | "active";
  icon: React.ReactNode;
};

function ActionButton({ label, onPress, disabled, tone = "default", icon }: ActionProps) {
  const bg =
    tone === "danger"
      ? FIELDS_COLORS.dangerMuted
      : tone === "active"
        ? FIELDS_COLORS.accentMuted
        : FIELDS_COLORS.pillSecondary;
  const border =
    tone === "danger"
      ? FIELDS_COLORS.dangerBorder
      : tone === "active"
        ? FIELDS_COLORS.accentBorder
        : FIELDS_COLORS.panelBorder;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      style={{
        height: 34,
        paddingHorizontal: 10,
        borderRadius: 8,
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        backgroundColor: bg,
        borderWidth: 1,
        borderColor: border,
        opacity: disabled ? 0.4 : 1,
      }}
    >
      {icon}
      <Text
        style={{
          color: tone === "danger" ? FIELDS_COLORS.danger : FIELDS_COLORS.textMain,
          fontSize: 12,
          fontWeight: "700",
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

/** Asks for the export file name; Save hands back the sanitized base name (no extension). */
function ExportNameModal({
  visible,
  initialName,
  multiFile,
  onCancel,
  onSave,
}: {
  visible: boolean;
  initialName: string;
  multiFile: boolean;
  onCancel: () => void;
  onSave: (baseName: string) => void;
}) {
  const [name, setName] = useState(initialName);
  const [lastInitial, setLastInitial] = useState(initialName);
  const [lastVisible, setLastVisible] = useState(visible);
  // Re-seed the field each time the prompt opens.
  if (visible !== lastVisible || initialName !== lastInitial) {
    setLastVisible(visible);
    setLastInitial(initialName);
    if (visible) setName(initialName);
  }
  const baseName = sanitizeExportBaseName(name);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <View
        style={{
          flex: 1,
          backgroundColor: FIELDS_COLORS.overlay,
          alignItems: "center",
          justifyContent: "center",
          padding: 16,
        }}
      >
        <View
          style={{
            width: "100%",
            maxWidth: 420,
            borderRadius: 12,
            backgroundColor: FIELDS_COLORS.cardSolid,
            borderWidth: 1,
            borderColor: FIELDS_COLORS.panelBorder,
            padding: 16,
            gap: 12,
          }}
        >
          <Text style={{ color: FIELDS_COLORS.textMain, fontSize: 15, fontWeight: "800" }}>
            Export edited CSV
          </Text>
          <Text style={{ color: FIELDS_COLORS.textMuted, fontSize: 12, lineHeight: 16 }}>
            {multiFile
              ? "One file per CSV, numbered _1, _2, … Deleted points are left out; a reversed plan is written last row first."
              : "Deleted points are left out; a reversed plan is written last row first."}
          </Text>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <TextInput
              value={name}
              onChangeText={setName}
              autoFocus
              selectTextOnFocus
              autoCapitalize="none"
              autoCorrect={false}
              placeholder="File name"
              placeholderTextColor={FIELDS_COLORS.textDim}
              returnKeyType="done"
              onSubmitEditing={() => baseName && onSave(baseName)}
              accessibilityLabel="Export file name"
              style={{
                flex: 1,
                height: 40,
                paddingHorizontal: 10,
                borderRadius: 8,
                borderWidth: 1,
                borderColor: FIELDS_COLORS.panelBorder,
                backgroundColor: FIELDS_COLORS.surfaceSolid,
                color: FIELDS_COLORS.textMain,
                fontSize: 14,
              }}
            />
            <Text style={{ color: FIELDS_COLORS.textMuted, fontSize: 13, fontWeight: "700" }}>.csv</Text>
          </View>
          <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 8 }}>
            <ActionButton label="Cancel" onPress={onCancel} icon={<X size={14} color={FIELDS_COLORS.textMain} strokeWidth={2.4} />} />
            <ActionButton
              label="Save"
              tone="active"
              disabled={baseName == null}
              onPress={() => baseName && onSave(baseName)}
              icon={<Download size={14} color={FIELDS_COLORS.textMain} strokeWidth={2.4} />}
            />
          </View>
        </View>
      </View>
    </Modal>
  );
}

type Props = {
  edit: CsvPointEditApi;
  /** Mission running / paused — edits are refused. */
  planLocked: boolean;
};

export function CsvPointEditPanel({ edit, planLocked }: Props) {
  const [exportOpen, setExportOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  if (!edit.hasCsv) return null;

  const status = describeCsvEditStatus({
    editMode: edit.editMode,
    rangeMode: edit.rangeMode,
    selectedCount: edit.selectedCount,
    deletedCount: edit.deletedCount,
    remainingTotal: edit.remainingTotal,
    summaries: edit.summaries,
  });
  const iconColor = FIELDS_COLORS.textMain;
  const editingDisabled = planLocked || edit.busy;

  return (
    <View
      style={{
        borderRadius: 10,
        backgroundColor: FIELDS_COLORS.surfaceSolid,
        borderWidth: 1,
        borderColor: edit.editMode ? FIELDS_COLORS.accentBrand : FIELDS_COLORS.panelBorder,
        overflow: "hidden",
        marginBottom: 12,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", padding: 12, gap: 10 }}>
        <Pencil
          size={16}
          color={edit.editMode ? FIELDS_COLORS.accentBrand : FIELDS_COLORS.textMuted}
          strokeWidth={2.4}
        />
        <View style={{ flex: 1 }}>
          <Text style={{ color: FIELDS_COLORS.textMain, fontSize: 13, fontWeight: "800" }}>
            Edit points
          </Text>
          <Text style={{ color: FIELDS_COLORS.textMuted, fontSize: 11, marginTop: 2 }}>
            {edit.busy ? "Updating path…" : status.headline}
          </Text>
        </View>
        {edit.editMode ? (
          <Pressable
            onPress={() => edit.setEditMode(false)}
            accessibilityRole="button"
            accessibilityLabel="Done editing points"
            style={{
              height: 32,
              paddingHorizontal: 12,
              borderRadius: 8,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: FIELDS_COLORS.accentBrand,
            }}
          >
            <Text style={{ color: FIELDS_COLORS.accentText, fontSize: 12, fontWeight: "800" }}>
              Done
            </Text>
          </Pressable>
        ) : (
          <Pressable
            onPress={() => edit.setEditMode(true)}
            disabled={editingDisabled}
            accessibilityRole="button"
            accessibilityLabel="Edit points"
            accessibilityState={{ disabled: editingDisabled }}
            style={{
              height: 32,
              paddingHorizontal: 12,
              borderRadius: 8,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: editingDisabled ? FIELDS_COLORS.pillSecondary : "#8b5cf6",
              opacity: editingDisabled ? 0.5 : 1,
            }}
          >
            <Text style={{ color: "#fff", fontSize: 12, fontWeight: "700" }}>Edit</Text>
          </Pressable>
        )}
      </View>

      {edit.editMode ? (
        <View style={{ paddingHorizontal: 12, paddingBottom: 12, gap: 10 }}>
          <Text style={{ color: FIELDS_COLORS.textDim, fontSize: 11, lineHeight: 15 }}>
            {status.hint}
          </Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            <ActionButton
              label={`Delete${edit.selectedCount > 0 ? ` (${edit.selectedCount})` : ""}`}
              tone="danger"
              disabled={edit.selectedCount === 0 || editingDisabled}
              onPress={edit.deleteSelected}
              icon={<Trash2 size={14} color={FIELDS_COLORS.danger} strokeWidth={2.4} />}
            />
            <ActionButton
              label="Range"
              tone={edit.rangeMode ? "active" : "default"}
              onPress={edit.toggleRangeMode}
              icon={<Ruler size={14} color={iconColor} strokeWidth={2.2} />}
            />
            <ActionButton
              label="Clear"
              disabled={edit.selectedCount === 0}
              onPress={edit.clearSelection}
              icon={<X size={14} color={iconColor} strokeWidth={2.4} />}
            />
          </View>
        </View>
      ) : null}

      {/* Undo / redo / restore stay available outside edit mode (history outlives the mode). */}
      {edit.editMode || edit.deletedCount > 0 || edit.canUndo || edit.canRedo ? (
        <View
          style={{
            flexDirection: "row",
            flexWrap: "wrap",
            gap: 8,
            paddingHorizontal: 12,
            paddingBottom: 12,
          }}
        >
          <ActionButton
            label="Undo"
            disabled={!edit.canUndo}
            onPress={edit.undo}
            icon={<Undo2 size={14} color={iconColor} strokeWidth={2.4} />}
          />
          <ActionButton
            label="Redo"
            disabled={!edit.canRedo}
            onPress={edit.redo}
            icon={<Redo2 size={14} color={iconColor} strokeWidth={2.4} />}
          />
          <ActionButton
            label="Restore all"
            disabled={edit.deletedCount === 0 || editingDisabled}
            onPress={edit.restoreAll}
            icon={<RotateCcw size={14} color={iconColor} strokeWidth={2.4} />}
          />
        </View>
      ) : null}

      {/* Whole-plan actions: no point selection needed, so they work outside edit mode too. */}
      <View
        style={{
          flexDirection: "row",
          flexWrap: "wrap",
          gap: 8,
          paddingHorizontal: 12,
          paddingBottom: 12,
        }}
      >
        <ActionButton
          label={edit.reversed ? "Reversed" : "Reverse"}
          tone={edit.reversed ? "active" : "default"}
          disabled={editingDisabled || edit.remainingTotal === 0}
          onPress={edit.reversePlan}
          icon={<ArrowDownUp size={14} color={iconColor} strokeWidth={2.4} />}
        />
        <ActionButton
          label={exporting ? "Exporting…" : "Export"}
          disabled={edit.busy || exporting || edit.remainingTotal === 0}
          onPress={() => setExportOpen(true)}
          icon={<Download size={14} color={iconColor} strokeWidth={2.4} />}
        />
      </View>

      <ExportNameModal
        visible={exportOpen}
        initialName={edit.defaultExportName}
        multiFile={edit.summaries.filter((s) => s.remainingCount > 0).length > 1}
        onCancel={() => setExportOpen(false)}
        onSave={(baseName) => {
          setExportOpen(false);
          setExporting(true);
          void edit.exportCsv(baseName).finally(() => setExporting(false));
        }}
      />

      {status.notices.length > 0 ? (
        <View style={{ paddingHorizontal: 12, paddingBottom: 12, gap: 6 }}>
          {status.notices.map((n) => (
            <Text
              key={n.text}
              style={{
                color: n.level === "error" ? FIELDS_COLORS.danger : FIELDS_COLORS.warning,
                fontSize: 11,
                lineHeight: 15,
              }}
            >
              {n.text}
            </Text>
          ))}
        </View>
      ) : null}
    </View>
  );
}
