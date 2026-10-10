/**
 * One native map for the whole app.
 *
 * Every screen that wants a map keeps rendering <MapView {...props}/> exactly as before, but
 * the dispatcher no longer creates a native map per screen — it publishes those props here
 * and the single <SharedMapHost/> (mounted once, under all pages) renders them. The native
 * map therefore survives navigation: no style reload, no "Loading map…", and the camera
 * (centre / zoom / bearing) stays wherever the operator left it.
 *
 * Several slots can exist at once during a page transition (the old screen unmounts in the
 * same commit the new one mounts). The slot that CLAIMED most recently wins, so the order of
 * mount/unmount cleanups never matters.
 */
import { useSyncExternalStore } from "react";

import type { MapViewProps } from "../mapViewTypes";

type Slot = { order: number; props: MapViewProps };

const slots = new Map<string, Slot>();
const listeners = new Set<() => void>();
let claimCounter = 0;
/** Props the host renders. Kept after the last slot is released so the map can stay parked. */
let hostProps: MapViewProps | null = null;

function recompute() {
  let best: Slot | null = null;
  for (const slot of slots.values()) {
    if (!best || slot.order > best.order) best = slot;
  }
  if (best) hostProps = best.props;
  listeners.forEach((l) => l());
}

/** Claim (first call) or update (later calls) the shared map for `owner`. */
export function publishMapSlot(owner: string, props: MapViewProps): void {
  const existing = slots.get(owner);
  slots.set(owner, { order: existing?.order ?? ++claimCounter, props });
  recompute();
}

/** Give the map up. The native map stays mounted (parked) with the last props. */
export function releaseMapSlot(owner: string): void {
  if (!slots.delete(owner)) return;
  recompute();
}

export function subscribeSharedMap(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Snapshot of what the host renders (also what useSharedMapProps returns). */
export function getSharedMapProps(): MapViewProps | null {
  return hostProps;
}

/** Props of the screen that currently owns the map (or the last owner, while parked). */
export function useSharedMapProps(): MapViewProps | null {
  return useSyncExternalStore(subscribeSharedMap, getSharedMapProps, getSharedMapProps);
}

/** True while at least one screen is claiming the map. */
export function hasActiveMapSlot(): boolean {
  return slots.size > 0;
}

/** Test helper: forget everything. */
export function resetSharedMapStore(): void {
  slots.clear();
  hostProps = null;
  claimCounter = 0;
  listeners.forEach((l) => l());
}

// ── Imperative handle (visible bounds for the offline-map download) ─────────────────────────

export type MapHandle = {
  /** [[neLon, neLat], [swLon, swLat]] of what is on screen right now. */
  getVisibleBounds: () => Promise<[[number, number], [number, number]] | null>;
};

let handle: MapHandle | null = null;

export function registerMapHandle(next: MapHandle | null): void {
  handle = next;
}

export async function getVisibleMapBounds(): Promise<[[number, number], [number, number]] | null> {
  try {
    return (await handle?.getVisibleBounds()) ?? null;
  } catch {
    return null;
  }
}
