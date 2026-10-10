import React, { Profiler, type ProfilerOnRenderCallback, type ReactNode } from "react";

/**
 * Dev-only render-loop probe.
 *
 * React reports "Maximum update depth exceeded" without saying WHICH subtree is looping.
 * A Profiler is told when a commit it contains was caused by an update scheduled during
 * the previous commit ("nested-update"); a long run of those under one id names the
 * culprit before React's limit (50) trips. Production builds render children untouched.
 */
const WINDOW_MS = 2000;
const WARN_AFTER = 20;
const counters = new Map<string, { n: number; since: number; warned: boolean }>();

const onRender: ProfilerOnRenderCallback = (id, phase) => {
  if (phase !== "nested-update") {
    counters.delete(id);
    return;
  }
  const now = Date.now();
  const c = counters.get(id);
  if (!c || now - c.since > WINDOW_MS) {
    counters.set(id, { n: 1, since: now, warned: false });
    return;
  }
  c.n += 1;
  if (c.n >= WARN_AFTER && !c.warned) {
    c.warned = true;
    console.warn(
      `[LoopProbe] "${id}" committed ${c.n} nested updates in ${now - c.since} ms — a setState ` +
        `inside an effect/layout handler under this subtree is re-triggering itself.`
    );
  }
};

export function LoopProbe({ id, children }: { id: string; children: ReactNode }) {
  if (!__DEV__) return <>{children}</>;
  return (
    <Profiler id={id} onRender={onRender}>
      {children}
    </Profiler>
  );
}
