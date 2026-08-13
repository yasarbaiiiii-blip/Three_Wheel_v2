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

    // Log unhandled rejections for release debugging. Do NOT preventDefault —
    // swallowing rejections hid real Start/load failures as "app not working".
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
      });
    } else {
      const previous = g.onunhandledrejection;
      g.onunhandledrejection = (event) => {
        onRejection(event?.reason ?? event);
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
