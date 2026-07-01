import React from "react";
import { View } from "react-native";
import Svg, { Line } from "react-native-svg";

import { SIGN_DATA, type RoadSignType } from "../../utils/roadSignTemplates";
import { FIELDS_COLORS } from "./fieldsTheme";

type RoadSignThumbnailProps = {
  sign: RoadSignType;
  size?: number;
  stroke?: string;
};

export function RoadSignThumbnail({ sign, size = 36, stroke = FIELDS_COLORS.textMain }: RoadSignThumbnailProps) {
  const segments = SIGN_DATA[sign] ?? [];

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
      <Svg width={size - 8} height={size - 8} viewBox="-1 -1 2 2">
        {segments.map((seg, index) => (
          <Line
            key={`${sign}-${index}`}
            x1={seg[0]}
            y1={-seg[1]}
            x2={seg[2]}
            y2={-seg[3]}
            stroke={stroke}
            strokeWidth={0.07}
            strokeLinecap="round"
          />
        ))}
      </Svg>
    </View>
  );
}