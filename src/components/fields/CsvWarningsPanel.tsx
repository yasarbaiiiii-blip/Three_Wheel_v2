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
  defaultExpanded,
  maxVisible = 8,
}: CsvWarningsPanelProps) {
  const total = critical.length + advisory.length;
  const [expanded, setExpanded] = useState(
    defaultExpanded ?? critical.length > 0
  );

  if (total === 0) return null;

  const critShow = expanded ? critical : critical.slice(0, 2);
  const advShow = expanded ? advisory : advisory.slice(0, Math.max(0, 2 - critShow.length));
  const hidden = total - critShow.length - advShow.length;

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
          <AlertTriangle size={14} color={FIELDS_COLORS.textMuted} />
        )}
        <Text
          style={{
            flex: 1,
            color: critical.length > 0 ? FIELDS_COLORS.warning : FIELDS_COLORS.textMain,
            fontSize: 12,
            fontWeight: "700",
          }}
        >
          {title}
          {total > 0 ? ` (${total})` : ""}
        </Text>
        {expanded ? (
          <ChevronUp size={16} color={FIELDS_COLORS.textDim} />
        ) : (
          <ChevronDown size={16} color={FIELDS_COLORS.textDim} />
        )}
      </Pressable>

      {critShow.map((w, i) => (
        <Text
          key={`c-${i}`}
          style={{ color: FIELDS_COLORS.warning, fontSize: 11, lineHeight: 15 }}
        >
          • {w}
        </Text>
      ))}
      {advShow.map((w, i) => (
        <Text
          key={`a-${i}`}
          style={{ color: FIELDS_COLORS.textMuted, fontSize: 11, lineHeight: 15 }}
        >
          • {w}
        </Text>
      ))}
      {!expanded && hidden > 0 ? (
        <Pressable onPress={() => setExpanded(true)}>
          <Text style={{ color: FIELDS_COLORS.accentBrand, fontSize: 11, fontWeight: "600" }}>
            Show {hidden} more…
          </Text>
        </Pressable>
      ) : null}
      {expanded && total > maxVisible ? (
        <Text style={{ color: FIELDS_COLORS.textDim, fontSize: 10 }}>
          Showing first {Math.min(total, critShow.length + advShow.length)} of {total}.
        </Text>
      ) : null}
    </View>
  );
}
