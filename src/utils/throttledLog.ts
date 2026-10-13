/**
 * Rate-limited console.warn for code that can run at packet or frame rate.
 *
 * In a dev build every console.warn goes through React Native's LogBox (which stores and processes
 * each one) and Metro; a warning that repeats 10x a second makes the whole app slower the longer it
 * runs. This logs a given key at most once per `intervalMs`.
 */
const lastLoggedAt = new Map<string, number>();
const MAX_KEYS = 200;

export function warnThrottled(key: string, intervalMs: number, ...args: unknown[]): boolean {
  const now = Date.now();
  const prev = lastLoggedAt.get(key);
  if (prev !== undefined && now - prev < intervalMs) return false;
  if (lastLoggedAt.size >= MAX_KEYS) lastLoggedAt.clear();
  lastLoggedAt.set(key, now);
  console.warn(...args);
  return true;
}

/** Test hook. */
export function resetThrottledLog(): void {
  lastLoggedAt.clear();
}
