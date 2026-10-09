/**
 * Dedicated Fixed-Rate Heartbeat Scheduler for Production Rover (DYX_3WD).
 *
 * Rules:
 * 1. Fixed rate: fires every 500 ms on a fixed clock, independent of request latency.
 *    Never waits for the previous request before scheduling the next tick.
 * 2. In-flight timeout: capped at 350 ms (< 500 ms), so it can never stretch cadence.
 * 3. Primary path: Socket.IO "heartbeat" event. Fallback: REST POST /api/heartbeat.
 * 4. Measures and reports actual interval, jitter, and JS thread blocking lag.
 */

export interface HeartbeatMetrics {
  targetIntervalMs: number;
  actualIntervalMs: number;
  jitterMs: number;
  threadLagMs: number;
  maxThreadBlockMs: number;
  lastSentAt: number | null;
  lastAckAt: number | null;
  consecutiveErrors: number;
  totalSent: number;
  totalAcks: number;
  isRunning: boolean;
  transport: "socket" | "rest" | "none";
}

export type HeartbeatSender = () => Promise<boolean | { ok: boolean; transport?: "socket" | "rest" }>;
export type MetricsListener = (metrics: HeartbeatMetrics) => void;

export const HEARTBEAT_INTERVAL_MS = 500;
export const HEARTBEAT_REQUEST_TIMEOUT_MS = 350;

export class HeartbeatScheduler {
  private targetIntervalMs: number;
  private sender: HeartbeatSender;
  private timerId: ReturnType<typeof setTimeout> | null = null;
  private isRunning = false;
  private inFlight = false;
  private nextScheduledTime = 0;
  private lastTriggerTime = 0;
  private listeners = new Set<MetricsListener>();

  private metrics: HeartbeatMetrics = {
    targetIntervalMs: HEARTBEAT_INTERVAL_MS,
    actualIntervalMs: HEARTBEAT_INTERVAL_MS,
    jitterMs: 0,
    threadLagMs: 0,
    maxThreadBlockMs: 0,
    lastSentAt: null,
    lastAckAt: null,
    consecutiveErrors: 0,
    totalSent: 0,
    totalAcks: 0,
    isRunning: false,
    transport: "none",
  };

  constructor(sender: HeartbeatSender, targetIntervalMs = HEARTBEAT_INTERVAL_MS) {
    this.sender = sender;
    this.targetIntervalMs = targetIntervalMs;
    this.metrics.targetIntervalMs = targetIntervalMs;
  }

  setSender(sender: HeartbeatSender) {
    this.sender = sender;
  }

  getMetrics(): HeartbeatMetrics {
    return { ...this.metrics };
  }

  subscribe(listener: MetricsListener): () => void {
    this.listeners.add(listener);
    listener(this.getMetrics());
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit() {
    const copy = this.getMetrics();
    this.listeners.forEach((l) => {
      try {
        l(copy);
      } catch (err) {
        console.warn("[HeartbeatScheduler] listener error:", err);
      }
    });
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.metrics.isRunning = true;
    this.nextScheduledTime = Date.now();
    this.lastTriggerTime = Date.now();
    this.emit();
    this.scheduleNextTick();
  }

  stop() {
    this.isRunning = false;
    this.metrics.isRunning = false;
    if (this.timerId !== null) {
      clearTimeout(this.timerId);
      this.timerId = null;
    }
    this.emit();
  }

  /**
   * Immediately triggers a heartbeat tick (e.g. app returning from background)
   * while keeping schedule anchored.
   */
  triggerNow() {
    if (!this.isRunning) return;
    if (this.timerId !== null) {
      clearTimeout(this.timerId);
      this.timerId = null;
    }
    this.tick();
  }

  private scheduleNextTick() {
    if (!this.isRunning) return;

    // Advance next target time by targetIntervalMs on a fixed cadence
    this.nextScheduledTime += this.targetIntervalMs;
    const now = Date.now();

    // If we fell far behind (e.g. app suspended), reset nextScheduledTime
    if (this.nextScheduledTime < now) {
      this.nextScheduledTime = now + this.targetIntervalMs;
    }

    const delay = Math.max(5, this.nextScheduledTime - now);
    this.timerId = setTimeout(() => {
      this.tick();
    }, delay);
  }

  private tick() {
    if (!this.isRunning) return;

    const now = Date.now();
    const actualInterval = this.lastTriggerTime > 0 ? now - this.lastTriggerTime : this.targetIntervalMs;
    this.lastTriggerTime = now;

    // Calculate JS thread blocking lag:
    // If actualInterval is significantly larger than target, JS event loop was blocked
    const threadLag = Math.max(0, actualInterval - this.targetIntervalMs);
    this.metrics.threadLagMs = threadLag;
    if (threadLag > this.metrics.maxThreadBlockMs) {
      this.metrics.maxThreadBlockMs = threadLag;
    }

    this.metrics.actualIntervalMs = actualInterval;
    this.metrics.jitterMs = Math.abs(actualInterval - this.targetIntervalMs);
    this.metrics.lastSentAt = now;
    this.metrics.totalSent += 1;

    // CRITICAL (Owner Rule 4):
    // Schedule the next tick IMMEDIATELY BEFORE awaiting asynchronous send work!
    // This guarantees request latency (even 1.2s) CANNOT stretch the cadence.
    this.scheduleNextTick();

    // Guard against overlapping requests: if a previous heartbeat is still in flight,
    // do not spawn a concurrent request; record consecutive error.
    if (this.inFlight) {
      this.metrics.consecutiveErrors += 1;
      this.emit();
      return;
    }

    // Fire asynchronous heartbeat sender in background with strict 350ms timeout
    void this.dispatchHeartbeat();

    this.emit();
  }

  private async dispatchHeartbeat(): Promise<void> {
    this.inFlight = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      // Enforce timeout strictly < 500 ms (350 ms)
      const timeoutPromise = new Promise<{ ok: false; timeout: true }>((resolve) => {
        timer = setTimeout(() => resolve({ ok: false, timeout: true }), HEARTBEAT_REQUEST_TIMEOUT_MS);
      });

      const senderPromise = this.sender().then((res) => {
        if (typeof res === "boolean") {
          return { ok: res, transport: undefined };
        }
        return res;
      });

      const result = await Promise.race([senderPromise, timeoutPromise]);

      if (result.ok) {
        this.metrics.lastAckAt = Date.now();
        this.metrics.consecutiveErrors = 0;
        this.metrics.totalAcks += 1;
        if ("transport" in result && result.transport) {
          this.metrics.transport = result.transport;
        }
      } else {
        this.metrics.consecutiveErrors += 1;
      }
    } catch {
      this.metrics.consecutiveErrors += 1;
    } finally {
      if (timer !== null) {
        clearTimeout(timer);
      }
      this.inFlight = false;
      this.emit();
    }
  }
}
