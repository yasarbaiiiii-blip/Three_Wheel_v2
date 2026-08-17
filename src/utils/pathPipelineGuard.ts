/**
 * Serializes rover path writes and drops stale async map hydrates.
 *
 * Two independent concerns:
 * - `generation` — every preview / recover / send / load / start that will
 *   `setLines` takes a token; a later start invalidates older tokens.
 * - `exclusive` — Send / Start / Load / Clear hold a mutex so Home Start
 *   cannot restage while Fields is still planning, and preview cannot
 *   clobber a commit in flight.
 *
 * Preview is allowed to interrupt another preview (new token, old result
 * dropped). It is refused while an exclusive write is held.
 */

export type PathExclusiveKind = "send" | "start" | "load" | "recover" | "parse" | "clear";

export type ExclusiveAcquire =
  | { ok: true; token: number }
  | { ok: false; holder: PathExclusiveKind };

export function createPathPipelineGuard() {
  let generation = 0;
  let exclusive: PathExclusiveKind | null = null;

  return {
    currentGeneration(): number {
      return generation;
    },

    isCurrent(token: number): boolean {
      return token === generation;
    },

    /** New async map write (preview). Invalidates in-flight preview hydrates. */
    beginAsyncMapWrite(): number {
      generation += 1;
      return generation;
    },

    exclusiveKind(): PathExclusiveKind | null {
      return exclusive;
    },

    isExclusive(): boolean {
      return exclusive != null;
    },

    tryExclusive(kind: PathExclusiveKind): ExclusiveAcquire {
      if (exclusive) return { ok: false, holder: exclusive };
      exclusive = kind;
      generation += 1;
      return { ok: true, token: generation };
    },

    releaseExclusive(kind: PathExclusiveKind): boolean {
      if (exclusive !== kind) return false;
      exclusive = null;
      return true;
    },
  };
}

export function exclusiveBusyMessage(holder: PathExclusiveKind): string {
  switch (holder) {
    case "send":
      return "Wait — Send to rover is still in progress.";
    case "start":
      return "Wait — Start is still in progress.";
    case "load":
      return "Wait — Load to controller is still in progress.";
    case "recover":
      return "Wait — restoring the loaded mission.";
    case "parse":
      return "Wait — parse is still in progress.";
    case "clear":
      return "Wait — clear is still in progress.";
    default:
      return "Wait — another path action is still in progress.";
  }
}
