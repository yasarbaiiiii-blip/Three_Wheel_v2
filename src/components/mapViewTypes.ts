/**
 * Shared props contract for the map. Both the legacy Leaflet implementation
 * (`MapViewLeaflet`) and the native Mapbox implementation (`MapViewNative`)
 * implement this exact interface, and the `MapView` dispatcher selects between
 * them. Keeping the type here (rather than inside an implementation file) lets
 * the dispatcher lazy-load implementations without creating import cycles.
 */
import type { TelemetrySnapshot, PlanLine } from "../types/plan";
import type { AutoOriginReference, MapGeometryFrame } from "../types/autoOrigin";
import type { PlacedItem } from "./BoundaryEditor";
import type { DesignPreviewAnchor } from "../types/designDocument";

export interface MapViewProps {
  styleURL?: string;
  telemetrySnapshot: TelemetrySnapshot | null;
  lines: PlanLine[];
  alignedRefPoints: { dxf_x: number; dxf_y: number; lat: number; lon: number }[];
  visible: boolean;
  /** Layers filter: whether the rover marker itself is drawn. Defaults to visible when omitted. */
  showRover?: boolean;
  recenterRoverTrigger?: number;
  recenterPlanTrigger?: number;
  resetNorthTrigger?: number;
  onSelectPoint?: (pt: { x: number; y: number }) => void;
  onSelectLine?: (id: string | null) => void;
  selectedLineId?: string | null;
  /**
   * Explicit, already-resolved set of lines to highlight, in place of the single
   * `selectedLineId` line — used by the Fields "Path Order & Load" list so clicking
   * the Extension or Transit row highlights every segment of that type at once
   * ("same-type broadcast"). Resolved by the caller (not derived here) because the
   * `lines` prop this component receives is already visibility-filtered — a hidden
   * layer's lines wouldn't be present to filter from if this component tried to
   * derive the set itself from `lines` + a layer name.
   */
  highlightedLines?: PlanLine[] | null;
  showCornerPoints?: boolean;
  /**
   * `lat`/`lon` are the point's own known real-world coordinate (typed in or CSV-imported)
   * — when present, the marker renders THERE, not at a re-projection of `x`/`y` through
   * whatever provisional map anchor happens to be active. Omit `lat`/`lon` only for a
   * freshly tapped point that has no coordinate yet, so it still shows where it was tapped.
   */
  selectedPoints?: { x: number; y: number; lat?: number; lon?: number }[];

  // Interactive templates mode support
  mode?: "fields" | "templates";
  placedItems?: PlacedItem[];
  selectedItemIds?: string[];
  lockPanDrag?: boolean;
  lockZoom?: boolean;
  boundaryWidth?: number;
  boundaryHeight?: number;
  indentSpacing?: number;
  sketchMode?: boolean;
  showRefPointLabels?: boolean;
  boundaryPosition?: { x: number; y: number };
  onMoveBoundary?: (x: number, y: number) => void;
  boundaryRotation?: number;
  onRotateBoundary?: (rotation: number) => void;
  showBoundaryPoints?: boolean;
  activeSnapPointId?: string | null;
  onPlaceRoverAtPoint?: (pointId: string, localX: number, localY: number) => void;

  onUpdatePlacedItem?: (id: string, updates: Partial<PlacedItem>) => void;
  onUpdatePlacedItems?: (items: PlacedItem[]) => void;
  onSelectionChange?: (ids: string[]) => void;
  multiTouchMode?: "both" | "scale" | "rotate";
  previewAnchor?: DesignPreviewAnchor;
  autoOriginReference?: AutoOriginReference | null;
  mapGeometryFrame?: MapGeometryFrame;
  stagedVerified?: boolean;
  autoOriginEnabled?: boolean;
  visualAlignmentAnchor?: {
    originLat: number;
    originLon: number;
    originDxfNorth: number;
    originDxfEast: number;
  } | null;

  /** Click-to-Mark: callback when user taps the map while drawing waypoints */
  onMapClickToMark?: (coord: { lat: number; lon: number }) => void;
  /** Click-to-Mark & Manual Drawing: array of user-drawn waypoints to render on the map */
  drawnWaypoints?: { lat: number; lon: number }[];
  /** Manual Drawing: if true, map panning is disabled and pan gestures trigger freehand drawing */
  manualDrawingEnabled?: boolean;
  /** Manual Drawing: callback invoked when a freehand drawing stroke finishes */
  onMapFreehandDrawUpdate?: (coords: { lat: number; lon: number }[]) => void;
  /** Ref to allow parent component to convert screen pixels to GPS coordinates */
  screenToGeoRef?: React.MutableRefObject<((screen: { x: number; y: number }) => Promise<{ lat: number; lon: number } | null>) | null>;

  /**
   * Align DXF "Multi-Point Fit" manual-placement aid: reference points (same source as the
   * yellow dots) the "plan-editing-group" placed item snaps onto when dragged within a tight
   * radius of one, showing a Figma/Illustrator-style guide line from the point to the plan
   * while it's close. Purely a manual-placement guide — never affects any computed fit.
   */
  snapRefPoints?: { lat: number; lon: number }[];
}
