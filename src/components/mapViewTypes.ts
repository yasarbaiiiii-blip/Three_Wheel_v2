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
  telemetrySnapshot: TelemetrySnapshot | null;
  lines: PlanLine[];
  alignedRefPoints: { dxf_x: number; dxf_y: number; lat: number; lon: number }[];
  visible: boolean;
  recenterRoverTrigger?: number;
  recenterPlanTrigger?: number;
  onSelectPoint?: (pt: { x: number; y: number }) => void;
  onSelectLine?: (id: string | null) => void;
  selectedLineId?: string | null;
  showCornerPoints?: boolean;

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
}
