import { beforeEach, describe, expect, it, vi } from "vitest";

import type { MapViewProps } from "../mapViewTypes";
import { MAP_CALLBACK_KEYS, mapValueEqual, stabilizeMapProps } from "./stableMapProps";
import {
  getSharedMapProps,
  publishMapSlot,
  resetSharedMapStore,
  subscribeSharedMap,
} from "./sharedMapStore";

const asProps = (value: Record<string, unknown>) => value as unknown as MapViewProps;
const lineA = { id: "a" };
const lineB = { id: "b" };

describe("mapValueEqual", () => {
  it("treats same-item arrays and same-value plain objects as equal", () => {
    expect(mapValueEqual([], [])).toBe(true);
    expect(mapValueEqual([lineA, lineB], [lineA, lineB])).toBe(true);
    expect(mapValueEqual({ x: 1, y: 2 }, { x: 1, y: 2 })).toBe(true);
  });

  it("sees an edited item even when the count is unchanged", () => {
    expect(mapValueEqual([lineA], [{ id: "a" }])).toBe(false);
    expect(mapValueEqual([lineA, lineB], [lineB, lineA])).toBe(false);
    expect(mapValueEqual({ x: 1 }, { x: 1, y: undefined })).toBe(false);
    expect(mapValueEqual({ x: 1 }, { x: 2 })).toBe(false);
  });

  it("does not look inside nested values or class instances", () => {
    expect(mapValueEqual({ p: { x: 1 } }, { p: { x: 1 } })).toBe(false);
    expect(mapValueEqual(new Date(0), new Date(0))).toBe(false);
  });
});

describe("stabilizeMapProps", () => {
  it("returns the previous object when nothing changed", () => {
    const prev = asProps({ lines: [lineA], selectedItemIds: [], visible: true });
    const next = asProps({ lines: [lineA], selectedItemIds: [], visible: true });
    expect(stabilizeMapProps(prev, next)).toBe(prev);
  });

  it("keeps references for unchanged values and takes changed ones", () => {
    const prevLines = [lineA];
    const prev = asProps({ lines: prevLines, selectedLineId: "a" });
    const result = stabilizeMapProps(prev, asProps({ lines: [lineA], selectedLineId: "b" })) as unknown as {
      lines: unknown;
      selectedLineId: string;
    };
    expect(result).not.toBe(prev);
    expect(result.lines).toBe(prevLines);
    expect(result.selectedLineId).toBe("b");
  });

  it("treats an added or removed prop as a change", () => {
    const prev = asProps({ lines: [] });
    expect(stabilizeMapProps(prev, asProps({ lines: [], showRover: true }))).not.toBe(prev);
    expect(stabilizeMapProps(asProps({ lines: [], showRover: true }), prev)).not.toBe(prev);
  });
});

describe("shared map with stabilized props", () => {
  beforeEach(() => resetSharedMapStore());

  it("inline arrays re-created on every screen render do not re-render the map", () => {
    const spy = vi.fn();
    const unsub = subscribeSharedMap(spy);
    publishMapSlot("home", asProps({ lines: [lineA], placedItems: [], visible: true }));
    publishMapSlot("home", asProps({ lines: [lineA], placedItems: [], visible: true }));
    publishMapSlot("home", asProps({ lines: [lineA], placedItems: [], visible: true }));
    expect(spy).toHaveBeenCalledTimes(1);
    unsub();
  });

  it("a real geometry change re-renders exactly once", () => {
    const spy = vi.fn();
    publishMapSlot("home", asProps({ lines: [lineA], visible: true }));
    const unsub = subscribeSharedMap(spy);
    publishMapSlot("home", asProps({ lines: [lineA, lineB], visible: true }));
    publishMapSlot("home", asProps({ lines: [lineA, lineB], visible: true }));
    expect(spy).toHaveBeenCalledTimes(1);
    unsub();
  });

  it("a new owner with the same plan still takes the map but reuses the drawn lines", () => {
    const homeLines = [lineA];
    publishMapSlot("home", asProps({ lines: homeLines, visible: true }));
    const spy = vi.fn();
    const unsub = subscribeSharedMap(spy);
    publishMapSlot("fields", asProps({ lines: [lineA], visible: true, mode: "fields" }));
    expect(spy).toHaveBeenCalledTimes(1);
    const host = getSharedMapProps() as unknown as { lines: unknown; mode: string };
    expect(host.mode).toBe("fields");
    expect(host.lines).toBe(homeLines);
    unsub();
  });
});

describe("MAP_CALLBACK_KEYS", () => {
  it("lists only on* handlers, each once", () => {
    expect(new Set(MAP_CALLBACK_KEYS).size).toBe(MAP_CALLBACK_KEYS.length);
    for (const key of MAP_CALLBACK_KEYS) expect(key.startsWith("on")).toBe(true);
  });
});
