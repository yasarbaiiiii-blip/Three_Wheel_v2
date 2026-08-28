import React, { useMemo } from "react";
import { Text, View } from "react-native";
import Svg, { Line } from "react-native-svg";

import type { PlanLine } from "../../types/plan";
import { templateBoundsM } from "../../utils/arrowTemplates";
import { FIELDS_COLORS } from "./fieldsTheme";
import { clampPreviewZoom, collectPreviewSegs, previewStrokeUser } from "./templateLinePreviewMath";

export { clampPreviewZoom, collectPreviewSegs, previewStrokeUser } from "./templateLinePreviewMath";

type TemplateLinePreviewProps = {
  lines: PlanLine[];
  size?: number;
  zoom?: number;
  panX?: number;
  panY?: number;
  stroke?: string;
  /** On-screen stroke in pixels. Stays constant when the mark size changes. */
  strokePx?: number;
  showDimensions?: boolean;
  /** Lay the long axis left-to-right so marks read in the square. */
  horizontal?: boolean;
  /**
   * Minimum world window in meters. The drawing keeps its true size inside this
   * plate, so shrinking a template scales the shape instead of thickening the stroke.
   */
  plateM?: number;
};

export function TemplateLinePreview({
  lines,
  size = 220,
  zoom = 1,
  panX = 0,
  panY = 0,
  stroke = FIELDS_COLORS.textMain,
  strokePx = 2,
  showDimensions = true,
  horizontal = true,
  plateM,
}: TemplateLinePreviewProps) {
  const frame = useMemo(() => collectPreviewSegs(lines, horizontal), [lines, horizontal]);
  const bounds = useMemo(() => templateBoundsM(lines), [lines]);
  const dimOpacity = showDimensions ? Math.min(1, Math.max(0.12, (zoom - 0.9) / 1.5)) : 0;
  const fitted = Math.max(0.2, frame.maxX - frame.minX);
  const span = Math.max(fitted, plateM ?? 0);
  const vb = span / clampPreviewZoom(zoom);
  const cx = (frame.minX + frame.maxX) / 2 - panX * (vb / Math.max(1, size));
  const cy = (frame.minY + frame.maxY) / 2 - panY * (vb / Math.max(1, size));
  const strokeWidth = previewStrokeUser(vb, size, strokePx);

  return (
    <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}>
      <Svg width={size} height={size} viewBox={`${cx - vb / 2} ${cy - vb / 2} ${vb} ${vb}`}>
        {frame.segs.map((seg, i) => (
          <Line
            key={i}
            x1={seg.x1}
            y1={seg.y1}
            x2={seg.x2}
            y2={seg.y2}
            stroke={stroke}
            strokeWidth={strokeWidth}
            strokeLinecap="round"
          />
        ))}
      </Svg>
      {showDimensions ? (
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            bottom: 8,
            left: 8,
            right: 8,
            opacity: dimOpacity,
            flexDirection: "row",
            justifyContent: "space-between",
          }}
        >
          <Text style={{ color: FIELDS_COLORS.accentBrand, fontSize: 11, fontWeight: "800" }}>
            {bounds.widthM.toFixed(2)} m W
          </Text>
          <Text style={{ color: FIELDS_COLORS.accentBrand, fontSize: 11, fontWeight: "800" }}>
            {bounds.heightM.toFixed(2)} m H
          </Text>
        </View>
      ) : null}
    </View>
  );
}
