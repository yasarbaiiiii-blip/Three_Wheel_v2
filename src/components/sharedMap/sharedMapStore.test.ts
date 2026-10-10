import { beforeEach, describe, expect, it, vi } from "vitest";

import type { MapViewProps } from "../mapViewTypes";
import {
  getSharedMapProps,
  getVisibleMapBounds,
  hasActiveMapSlot,
  publishMapSlot,
  registerMapHandle,
  releaseMapSlot,
  resetSharedMapStore,
  subscribeSharedMap,
} from "./sharedMapStore";

const props = (tag: string) => ({ tag, visible: true } as unknown as MapViewProps);
const tagOf = () => (getSharedMapProps() as unknown as { tag?: string } | null)?.tag ?? null;

describe("sharedMapStore", () => {
  beforeEach(() => {
    resetSharedMapStore();
    registerMapHandle(null);
  });

  it("starts with no map requested", () => {
    expect(hasActiveMapSlot()).toBe(false);
    expect(getSharedMapProps()).toBeNull();
  });

  it("the claiming screen's props are what the host renders", () => {
    publishMapSlot("home", props("home"));
    expect(tagOf()).toBe("home");
  });

  it("after the last screen releases, the map stays parked on its last props (not unmounted)", () => {
    publishMapSlot("home", props("home"));
    releaseMapSlot("home");
    expect(hasActiveMapSlot()).toBe(false);
    expect(tagOf()).toBe("home");
  });

  it("navigating Home → Fields: the most recent claim wins even if Home's cleanup runs last", () => {
    publishMapSlot("home", props("home"));
    publishMapSlot("fields", props("fields")); // Fields mounts first…
    expect(tagOf()).toBe("fields");
    releaseMapSlot("home"); // …then Home's unmount cleanup runs
    expect(tagOf()).toBe("fields");
    expect(hasActiveMapSlot()).toBe(true);
  });

  it("and when cleanup runs BEFORE the new screen mounts, the new screen still ends up owning it", () => {
    publishMapSlot("home", props("home"));
    releaseMapSlot("home");
    publishMapSlot("fields", props("fields"));
    expect(tagOf()).toBe("fields");
  });

  it("a screen re-rendering with new props updates the map without stealing it from the owner", () => {
    publishMapSlot("home", props("home-1"));
    publishMapSlot("fields", props("fields-1"));
    publishMapSlot("home", props("home-2")); // Home re-renders while Fields owns the map
    expect(tagOf()).toBe("fields-1");
    releaseMapSlot("fields");
    expect(tagOf()).toBe("home-2"); // falls back to Home's LATEST props
  });

  it("the owner's re-render replaces its props (lines, selection, callbacks stay current)", () => {
    publishMapSlot("fields", props("fields-1"));
    publishMapSlot("fields", props("fields-2"));
    expect(tagOf()).toBe("fields-2");
  });

  it("releasing an unknown owner is harmless and does not notify", () => {
    const spy = vi.fn();
    const unsub = subscribeSharedMap(spy);
    releaseMapSlot("nobody");
    expect(spy).not.toHaveBeenCalled();
    unsub();
  });

  it("subscribers hear about publishes and releases, and can unsubscribe", () => {
    const spy = vi.fn();
    const unsub = subscribeSharedMap(spy);
    publishMapSlot("a", props("a"));
    releaseMapSlot("a");
    expect(spy).toHaveBeenCalledTimes(2);
    unsub();
    publishMapSlot("b", props("b"));
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("visible bounds come from the registered map and degrade to null on failure", async () => {
    expect(await getVisibleMapBounds()).toBeNull();
    registerMapHandle({ getVisibleBounds: async () => [[80.1, 13.1], [80.0, 13.0]] });
    expect(await getVisibleMapBounds()).toEqual([[80.1, 13.1], [80.0, 13.0]]);
    registerMapHandle({
      getVisibleBounds: async () => {
        throw new Error("native gone");
      },
    });
    expect(await getVisibleMapBounds()).toBeNull();
  });
});
