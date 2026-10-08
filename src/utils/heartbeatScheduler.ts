/**
 * Dedicated Heartbeat Scheduler for Production Backend (DYX_3WD).
 *
 * Rules:
 * 1. Target interval: 500 ms. Timeout on rover: 1500 ms.
 * 2. Decoupled from React render cycles.
 * 3. Measures actual interval and jitter, reporting them for display in the debug UI.
 */

export interface HeartbeatMetrics {
  targetIntervalMs: number;
  actualIntervalMs: number;
  jitterMs: number;
  lastSentAt: number | null;
  lastAckAt: number | null;
  consecutiveErrors: number;
  totalSent: number;
  totalAcks: number;
  isRunning: boolean;
}

export type HeartbeatSender = () => Promise<boolean | void>;
export type MetricsListener = (metrics: HeartbeatMetrics) => void;

export class HeartbeatScheduler {
  private targetIntervalMs: number;
  private sender: HeartbeatSender;
  private timerId: ReturnType<typeof setTimeout> | null = null;
  private isRunning = false;
  private lastTriggerTime = 0;
  private listeners = new Set<MetricsListener>();

  private metrics: HeartbeatMetrics = {
    targetIntervalMs: 500,
    actualIntervalMs: 500,
    jitterMs: 0,
    lastSentAt: null,
    lastAckAt: null,
    consecutiveErrors: 0,
    totalSent: 0,
    totalAcks: 0,
    isRunning: false,
  };

  constructor(sender: HeartbeatSender, targetIntervalMs = 500) {
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
    this.lastTriggerTime = Date.now();
    this.emit();
    this.scheduleNext();
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

  private scheduleNext(delayMs = this.targetIntervalMs) {
    if (!this.isRunning) return;
    this.timerId = setTimeout(() => {
      void this.tick();
    }, Math.max(10, delayMs));
  }

  private async tick() {
    if (!this.isRunning) return;

    const now = Date.now();
    const actualInterval = this.lastTriggerTime > 0 ? now - this.lastTriggerTime : this.targetIntervalMs;
    this.lastTriggerTime = now;

    this.metrics.actualIntervalMs = actualInterval;
    this.metrics.jitterMs = Math.abs(actualInterval - this.targetIntervalMs);
    this.metrics.lastSentAt = now;
    this.metrics.totalSent += 1;

    // Next scheduled target time (drift compensation)
    const nextTargetDelay = Math.max(
      10,
      this.targetIntervalMs - (Date.now() - now)
    );

    try {
      const ok = await this.sender();
      if (ok === false) {
        this.metrics.consecutiveErrors += 1;
      } else {
        this.metrics.lastAckAt = Date.now();
        this.metrics.consecutiveErrors = 0;
        this.metrics.totalAcks += 1;
      }
    } catch {
      this.metrics.consecutiveErrors += 1;
    } finally {
      this.emit();
      this.scheduleNext(nextTargetDelay);
    }
  }
}
