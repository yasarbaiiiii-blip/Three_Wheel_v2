import React from "react";
import { View, Text } from "react-native";
import Svg, { Circle as SvgCircle, Line, Polygon, G, Text as SvgText } from "react-native-svg";

type CompassColors = {
  surfaceSolid: string;
  accentBorder: string;
  panelBorder: string;
  danger: string;
  textDim: string;
  accentBrand: string;
  bgBase: string;
  textMain: string;
};

type CompassProps = {
  headingDeg: number;
  hasRoverHeading: boolean;
  colors: CompassColors;
  style?: any;
  labelStyle?: any;
  labelIdleStyle?: any;
};

const normalizeHeadingDeg = (deg: number) => ((deg % 360) + 360) % 360;

function CompassImpl({ headingDeg, hasRoverHeading, colors, style, labelStyle, labelIdleStyle }: CompassProps) {
  const size = 34;
  const cx = size / 2;
  const r = size / 2 - 2;
  const displayHeading = hasRoverHeading ? normalizeHeadingDeg(headingDeg) : null;

  return (
    <View style={style}>
      <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <SvgCircle
          cx={cx}
          cy={cx}
          r={r}
          fill={colors.surfaceSolid}
          stroke={hasRoverHeading ? colors.accentBorder : colors.panelBorder}
          strokeWidth={1.2}
        />
        <SvgText x={cx} y={9} fontSize={7} fill={colors.danger} fontWeight="900" textAnchor="middle">N</SvgText>
        <SvgText x={cx} y={size - 4} fontSize={6} fill={colors.textDim} fontWeight="700" textAnchor="middle">S</SvgText>
        <SvgText x={size - 5} y={cx + 2} fontSize={6} fill={colors.textDim} fontWeight="700" textAnchor="middle">E</SvgText>
        <SvgText x={5} y={cx + 2} fontSize={6} fill={colors.textDim} fontWeight="700" textAnchor="middle">W</SvgText>
        {[0, 45, 90, 135, 180, 225, 270, 315].map((deg) => {
          const tickR = deg % 90 === 0 ? 3 : 1.8;
          const rad = (deg * Math.PI) / 180;
          const inner = r - 7;
          const outer = inner + tickR;
          return (
            <Line
              key={deg}
              x1={cx + inner * Math.sin(rad)}
              y1={cx - inner * Math.cos(rad)}
              x2={cx + outer * Math.sin(rad)}
              y2={cx - outer * Math.cos(rad)}
              stroke={colors.textDim}
              strokeWidth={deg % 90 === 0 ? 1.2 : 0.8}
            />
          );
        })}
        <G transform={hasRoverHeading ? `rotate(${displayHeading} ${cx} ${cx})` : undefined}>
          <Polygon
            points={`${cx},${cx - 9} ${cx + 2},${cx} ${cx - 2},${cx}`}
            fill={hasRoverHeading ? colors.accentBrand : colors.textDim}
          />
          <Polygon
            points={`${cx},${cx + 9} ${cx + 2},${cx} ${cx - 2},${cx}`}
            fill={colors.panelBorder}
          />
          <SvgCircle cx={cx} cy={cx} r={2} fill={colors.bgBase} stroke={colors.textMain} strokeWidth={0.8} />
        </G>
      </Svg>
      <Text style={[labelStyle, !hasRoverHeading && labelIdleStyle]}>
        {hasRoverHeading ? `${(displayHeading as number).toFixed(0)}°` : "--"}
      </Text>
    </View>
  );
}

function arePropsEqual(prev: CompassProps, next: CompassProps): boolean {
  if (prev.hasRoverHeading !== next.hasRoverHeading) return false;
  if (prev.colors !== next.colors) return false;
  if (prev.style !== next.style || prev.labelStyle !== next.labelStyle || prev.labelIdleStyle !== next.labelIdleStyle) {
    return false;
  }
  // Skip re-render for sub-0.5-degree heading jitter.
  return Math.abs(prev.headingDeg - next.headingDeg) < 0.5;
}

export const Compass = React.memo(CompassImpl, arePropsEqual);
export default Compass;
