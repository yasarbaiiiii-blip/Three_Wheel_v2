export type AutoOriginReference = {
  planStartNorth: number;
  planStartEast: number;
  roverNorth: number;
  roverEast: number;
  latitude: number;
  longitude: number;
  capturedAtMs: number;
};

export type MapGeometryFrame =
  | "RAW_DESIGN"
  | "AUTO_ORIGIN_RAW"
  | "ALIGNED_DESIGN"
  | "SURVEYED_LOCAL"
  | "GEOGRAPHIC"
  | "NONE";