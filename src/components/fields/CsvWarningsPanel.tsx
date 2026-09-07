/**
 * Shared expandable warnings panel for CSV Upload / Path Order / Send.
 */

import React, { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { AlertTriangle, ChevronDown, ChevronUp, ShieldAlert } from "lucide-react-native";

import { FIELDS_COLORS } from "./fieldsTheme";

export type CsvWarningsPanelProps = {
  title?: string;
  /** Hard / critical items (red-amber). */
  critical?: string[];
  /** Soft notices. */
  advisory?: string[];
  /** Initially expanded when there is critical content. */
  defaultExpanded?: boolean;
  maxVisible?: number;
};

export function CsvWarningsPanel({
  title = "CSV warnings",
  critical = [],
  advisory = [],
  defaultExpanded = false,
  maxVisible = 8,
}: CsvWarningsPanelProps) {
  const total = critical.length + advisory.length;
  const [expanded, setExpanded] = useState(defaultExpanded);

  if (total === 0) return null;

  const all = [
    ...critical.map((w) => ({ kind: "critical" as const, text: w })),
    ...advisory.map((w) => ({ kind: "advisory" as const, text: w })),
  ];
  const shown = expanded ? all.slice(0, maxVisible) : [];

  return (
    <View
      style={{
        borderRadius: 10,
        borderWidth: 1,
        borderColor:
          critical.length > 0 ? FIELDS_COLORS.warningBorder : FIELDS_COLORS.panelBorder,
        backgroundColor:
          critical.length > 0 ? FIELDS_COLORS.warningMuted : FIELDS_COLORS.surfaceSolid,
        padding: 10,
        gap: 6,
      }}
    >
      <Pressable
        onPress={() => setExpanded((e) => !e)}
        style={{ flexDirection: "row", alignItems: "center", gap: 8 }}
      >
        {critical.length > 0 ? (
          <ShieldAlert size={14} color={FIELDS_COLORS.warning} />
        ) : (
          <AlertTriangle size={14} color={FIELDS_COLORS.warning} />
        )}
        <Text
          style={{
            flex: 1,
            color: FIELDS_COLORS.warning,
            fontSize: 12,
            fontWeight: "700",
          }}
        >
          {title} · {total}
        </Text>
        {expanded ? (
          <ChevronUp size={16} color={FIELDS_COLORS.textDim} />
        ) : (
          <ChevronDown size={16} color={FIELDS_COLORS.textDim} />
        )}
      </Pressable>

      {shown.map((w, i) => (
        <Text
          key={`${w.kind}-${i}`}
          style={{
            color: w.kind === "critical" ? FIELDS_COLORS.warning : FIELDS_COLORS.textMuted,
            fontSize: 11,
            lineHeight: 15,
          }}
          numberOfLines={2}
        >
          {w.text}
        </Text>
      ))}
    </View>
  );
}
