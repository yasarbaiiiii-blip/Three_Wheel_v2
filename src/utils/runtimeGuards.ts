/**
 * Process-level guards so unhandled JS errors / promise rejections log and
 * (where possible) do not silently kill a release APK without a breadcrumb.
 *
 * Does not catch native SIGSEGV (e.g. Mapbox). Pair with AppErrorBoundary for
 * React render trees.
 */

let installed = false;

export function installRuntimeGuards(): void {
  if (installed) return;
  installed = true;

  try {
    const g = globalThis as typeof globalThis & {
      ErrorUtils?: {
        getGlobalHandler?: () => (error: Error, isFatal?: boolean) => void;
        setGlobalHandler?: (handler: (error: Error, isFatal?: boolean) => void) => void;
      };
      onunhandledrejection?: ((event: { reason?: unknown; preventDefault?: () => void }) => void) | null;
      addEventListener?: (type: string, listener: (event: any) => void) => void;
    };

    const EU = g.ErrorUtils;
    if (EU?.getGlobalHandler && EU?.setGlobalHandler) {
      const prev = EU.getGlobalHandler();
      EU.setGlobalHandler((error, isFatal) => {
        console.error("[JS_FATAL]", isFatal, error?.message ?? error, error?.stack);
        // Always forward so RN's default handling still runs; we only ensure
        // a durable log line before process death on true fatals.
        try {
          prev?.(error, isFatal);
        } catch (forwardErr) {
          console.error("[JS_FATAL] default handler failed:", forwardErr);
        }
      });
    }

    // Hermes / RN: unhandled promise rejections often surface as "app closed"
    // without a redbox in release. Swallow after logging so a single bad await
    // in a fire-and-forget path does not terminate the process when the runtime
    // treats rejections as fatal.
    const onRejection = (reason: unknown) => {
      const msg =
        reason instanceof Error
          ? reason.message
          : typeof reason === "string"
            ? reason
            : JSON.stringify(reason);
      console.error("[UNHANDLED_REJECTION]", msg, reason instanceof Error ? reason.stack : "");
    };

    if (typeof g.addEventListener === "function") {
      g.addEventListener("unhandledrejection", (event: any) => {
        onRejection(event?.reason ?? event);
        try {
          event?.preventDefault?.();
        } catch {
          /* ignore */
        }
      });
    } else {
      // Fallback for environments without addEventListener on globalThis
      const previous = g.onunhandledrejection;
      g.onunhandledrejection = (event) => {
        onRejection(event?.reason ?? event);
        try {
          event?.preventDefault?.();
        } catch {
          /* ignore */
        }
        if (typeof previous === "function") {
          try {
            previous(event);
          } catch {
            /* ignore */
          }
        }
      };
    }
  } catch (err) {
    console.warn("[runtimeGuards] install failed:", err);
  }
}

/** Yield to the UI thread so busy spinners / toasts paint before heavy work. */
export function yieldToUi(): Promise<void> {
  return new Promise((resolve) => {
    // Double rAF: one for layout, one for paint — more reliable than a single frame.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => resolve());
    });
  });
}
