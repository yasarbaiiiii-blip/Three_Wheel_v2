/**
 * Keeps map props referentially stable so the 4,000-line map body (and every plan
 * ShapeSource, which JSON.stringifies its GeoJSON on render) only re-renders for real changes.
 *
 * Screens build map props inline (`placedItems={x ? [x] : []}`, `?? []` fallbacks, wrapper
 * arrays, new callbacks). Two layers absorb that at the map boundary:
 *  - every callback prop is replaced by a stable proxy that calls the latest committed handler;
 *  - every data prop whose CONTENT is unchanged keeps its previous reference. "Unchanged" is a
 *    cheap, exact check: same reference, or an array of the same items in the same order, or a
 *    plain object with the same keys and identical values. Items are compared by reference, so
 *    an edited line (a new object) is always a change, even when counts stay the same.
 */
import { useLayoutEffect, useMemo, useRef } from "react";

import type { MapViewProps } from "../mapViewTypes";

type AnyFn = (...args: never[]) => unknown;

/** Every function-typed prop of MapViewProps. */
export type MapCallbackKey = {
  [K in keyof MapViewProps]-?: NonNullable<MapViewProps[K]> extends AnyFn ? K : never;
}[keyof MapViewProps];

/**
 * Must list every callback prop: adding a function prop to MapViewProps without listing it
 * here is a type error, so a new handler can never be silently compared away and go stale.
 */
const MAP_CALLBACK_KEY_SET = {
  onSelectPoint: true,
  onMapPlacePoint: true,
  onGuidePointFocus: true,
  onSelectLine: true,
  onMoveBoundary: true,
  onRotateBoundary: true,
  onPlaceRoverAtPoint: true,
  onUpdatePlacedItem: true,
  onUpdatePlacedItems: true,
  onSelectionChange: true,
  onMapClickToMark: true,
  onMapFreehandDrawUpdate: true,
  onPlanAttached: true,
  onAnchorCandidateSelect: true,
  onCsvEditPointPress: true,
} as const satisfies Record<MapCallbackKey, true>;

export const MAP_CALLBACK_KEYS = Object.keys(MAP_CALLBACK_KEY_SET) as MapCallbackKey[];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Same reference, or same-order identical array items, or same-key identical object values. */
export function mapValueEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
    return true;
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const aKeys = Object.keys(a);
    if (aKeys.length !== Object.keys(b).length) return false;
    for (const key of aKeys) {
      if (!Object.prototype.hasOwnProperty.call(b, key) || !Object.is(a[key], b[key])) return false;
    }
    return true;
  }
  return false;
}

/**
 * Returns `next` with every content-unchanged value replaced by the value from `prev`, or
 * `prev` itself when nothing changed at all (so callers can compare with ===).
 */
export function stabilizeMapProps(prev: MapViewProps | null, next: MapViewProps): MapViewProps {
  if (!prev) return next;
  const prevRecord = prev as unknown as Record<string, unknown>;
  const nextRecord = next as unknown as Record<string, unknown>;
  const nextKeys = Object.keys(nextRecord);
  let changed = nextKeys.length !== Object.keys(prevRecord).length;
  const result: Record<string, unknown> = {};
  for (const key of nextKeys) {
    const nextValue = nextRecord[key];
    if (Object.prototype.hasOwnProperty.call(prevRecord, key) && mapValueEqual(prevRecord[key], nextValue)) {
      result[key] = prevRecord[key];
    } else {
      result[key] = nextValue;
      changed = true;
    }
  }
  return changed ? (result as unknown as MapViewProps) : prev;
}

/**
 * Replaces each callback prop with a proxy whose identity never changes and which calls the
 * handler from the latest committed render. A missing handler stays undefined, so the map
 * still sees whether a handler exists (e.g. tap-to-mark enabled or not).
 */
export function useStableMapCallbacks(props: MapViewProps): MapViewProps {
  const latestRef = useRef(props);
  useLayoutEffect(() => {
    latestRef.current = props;
  });

  const proxies = useMemo(() => {
    const out: Partial<Record<MapCallbackKey, AnyFn>> = {};
    for (const key of MAP_CALLBACK_KEYS) {
      out[key] = ((...args: unknown[]) => {
        const handler = latestRef.current[key] as ((...values: unknown[]) => unknown) | undefined;
        return typeof handler === "function" ? handler(...args) : undefined;
      }) as AnyFn;
    }
    return out;
  }, []);

  const withProxies = { ...props } as Record<string, unknown>;
  for (const key of MAP_CALLBACK_KEYS) {
    withProxies[key] = typeof props[key] === "function" ? proxies[key] : undefined;
  }
  return withProxies as unknown as MapViewProps;
}
