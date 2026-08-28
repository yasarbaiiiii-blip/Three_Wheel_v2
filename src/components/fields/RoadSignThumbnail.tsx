import React from "react";
import { View } from "react-native";
import Svg, { Line } from "react-native-svg";

import { SIGN_DATA, type RoadSignType } from "../../utils/roadSignTemplates";
import { FIELDS_COLORS } from "./fieldsTheme";

type RoadSignThumbnailProps = {
  sign: RoadSignType;
  size?: number;
  stroke?: string;
  /** Draw only the mark, no chrome — for embedding in a parent tile. */
  bare?: boolean;
};

export function RoadSignThumbnail({
  sign,
  size = 36,
  stroke = FIELDS_COLORS.textMain,
  bare = false,
}: RoadSignThumbnailProps) {
  const segments = SIGN_DATA[sign] ?? [];
  const art = bare ? size : Math.max(8, size - 8);
  const mark = (
    <Svg width={art} height={art} viewBox="-0.62 -0.62 1.24 1.24">
      {segments.map((seg, index) => (
        <Line
          key={`${sign}-${index}`}
          x1={seg[0]}
          y1={-seg[1]}
          x2={seg[2]}
          y2={-seg[3]}
          stroke={stroke}
          strokeWidth={0.02}
          strokeLinecap="round"
        />
      ))}
    </Svg>
  );
  if (bare) return mark;
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: 8,
        backgroundColor: FIELDS_COLORS.surfaceSolid,
        borderWidth: 1,
        borderColor: FIELDS_COLORS.panelBorder,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {mark}
    </View>
  );
}
