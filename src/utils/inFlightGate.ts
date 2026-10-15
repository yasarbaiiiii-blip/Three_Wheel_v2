/**
 * Synchronous single-flight gate. `tryEnter()` is check-and-set in one step (no await between), so
 * a second press, a re-entrant call or a re-render cannot pass while the first is running. Keep the
 * gate in a ref (or module scope), never in state: state updates are not visible until the next render.
 */
export type InFlightGate = {
  tryEnter(): boolean;
  leave(): void;
  isBusy(): boolean;
};

export function createInFlightGate(): InFlightGate {
  let busy = false;
  return {
    tryEnter() {
      if (busy) return false;
      busy = true;
      return true;
    },
    leave() {
      busy = false;
    },
    isBusy() {
      return busy;
    },
  };
}
