/**
 * Production Socket.IO Connection Manager (DYX_3WD)
 *
 * Rules:
 * 1. transports: ["websocket"] only.
 * 2. Handshake: auth: { token: string }.
 * 3. Automatic reconnect with exponential backoff (capped at 5s).
 * 4. Stop reconnecting on 401 / unauthorized -> set status "unauthorized".
 * 5. Immediate "disconnected" status on disconnect.
 * 6. AppState listener: tablet wake-up / app foregrounding checks connection immediately.
 * 7. Fixed-rate heartbeat emit via socket "heartbeat" event (capped at 350ms).
 * 8. Inbound: "telemetry" (periodic snapshot) and "rover_event" (the one status event: mission_state,
 *    operator_link, fcu_link, estop, gateway_link; per kind the highest seq wins, see roverEventStore).
 *    There is no "gateway" or "mission_event" event any more.
 */

import { io, type Socket } from "socket.io-client";
import { AppState, type NativeEventSubscription } from "react-native";
import { ROVER_EVENT, type TelemetryPacket } from "../contract/prod/realtime";
import { ingestTelemetryPacket, setProdSocketConnected, invalidateTelemetrySession } from "../features/telemetry/prodTelemetryStore";
import { ingestRoverEvent, setRoverSocketConnected } from "../features/telemetry/roverEventStore";

export type ProdSocketStatus = "disconnected" | "connecting" | "connected" | "error" | "unauthorized";
export type SocketStatusListener = (status: ProdSocketStatus, detail?: string) => void;

export class ProdSocketManager {
  private socket: Socket | null = null;
  private currentUrl = "";
  private currentToken: string | null = null;
  private status: ProdSocketStatus = "disconnected";
  private listeners = new Set<SocketStatusListener>();
  private appStateSubscription: NativeEventSubscription | null = null;

  constructor() {
    this.setupAppStateListener();
  }

  private setupAppStateListener() {
    try {
      if (AppState && typeof AppState.addEventListener === "function") {
        this.appStateSubscription = AppState.addEventListener("change", (nextState) => {
          if (nextState === "active") {
            invalidateTelemetrySession("resume");
            // Tablet woke up / app foregrounded: verify socket state immediately
            if (this.socket) {
              if (!this.socket.connected) {
                this.setStatus("disconnected", "app_foreground_offline");
                setRoverSocketConnected(false);
                this.socket.connect();
              }
            }
          }
        });
      }
    } catch {
      // In non-react-native environments (vitest / unit test runner)
    }
  }

  getStatus(): ProdSocketStatus {
    return this.status;
  }

  subscribeStatus(listener: SocketStatusListener): () => void {
    this.listeners.add(listener);
    listener(this.status);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private setStatus(status: ProdSocketStatus, detail?: string) {
    this.status = status;
    this.listeners.forEach((l) => {
      try {
        l(status, detail);
      } catch (err) {
        console.warn("[ProdSocket] status listener error:", err);
      }
    });
  }

  connect(baseUrl: string, token: string | null): Promise<void> {
    this.disconnect();

    this.currentUrl = baseUrl;
    this.currentToken = token;
    this.setStatus("connecting");

    return new Promise((resolve, reject) => {
      let resolved = false;

      try {
        this.socket = io(baseUrl, {
          transports: ["websocket"],
          reconnection: true,
          reconnectionAttempts: Infinity,
          reconnectionDelay: 500,
          reconnectionDelayMax: 5000,
          timeout: 10000,
          forceNew: true,
          auth: token ? { token } : undefined,
        });

        const timer = setTimeout(() => {
          if (!resolved && this.status === "connecting") {
            console.warn("[ProdSocket] Socket connect taking longer than 10s...");
          }
        }, 10000);

        this.socket.on("connect", () => {
          clearTimeout(timer);
          // A new connection: forget every kind. The backend now replays the latest event of each
          // kind (replay:true) before anything else, so the state is rebuilt without polling.
          setRoverSocketConnected(true);
          setProdSocketConnected(true);
          this.setStatus("connected");
          if (!resolved) {
            resolved = true;
            resolve();
          }
        });

        this.socket.on("disconnect", (reason) => {
          // Nothing is known about the rover while the link is down: never keep the last values.
          setRoverSocketConnected(false);
          setProdSocketConnected(false);
          this.setStatus("disconnected", String(reason));
        });

        this.socket.on("connect_error", (err) => {
          const msg = err instanceof Error ? err.message : String(err);
          const isAuthError =
            msg.includes("401") ||
            msg.toLowerCase().includes("unauthoriz") ||
            msg.toLowerCase().includes("forbidden") ||
            (err as any)?.data?.status === 401 ||
            (err as any)?.description === 401;

          if (isAuthError) {
            console.warn("[ProdSocket] 401/Unauthorized received. Stopping reconnect.");
            if (this.socket) {
              this.socket.disconnect();
            }
            this.setStatus("unauthorized", msg);
            if (!resolved) {
              resolved = true;
              reject(err);
            }
            return;
          }

          this.setStatus("error", msg);
          if (!resolved) {
            resolved = true;
            reject(err);
          }
        });

        // Inbound production events
        this.socket.on("telemetry", (packet: TelemetryPacket | string) => {
          try {
            const data: TelemetryPacket = typeof packet === "string" ? JSON.parse(packet) : packet;
            ingestTelemetryPacket(data, { source: "socket" });
          } catch (e) {
            console.warn("[ProdSocket] Error parsing telemetry event:", e);
          }
        });

        this.socket.on(ROVER_EVENT, (packet: unknown) => {
          const result = ingestRoverEvent(packet);
          if (result === "invalid") console.warn("[ProdSocket] Ignored a malformed rover_event:", packet);
        });
      } catch (err) {
        this.setStatus("error", err instanceof Error ? err.message : String(err));
        if (!resolved) {
          resolved = true;
          reject(err);
        }
      }
    });
  }

  /**
   * Sends heartbeat event with a hard timeout of <= 350 ms.
   * Resolves { ok: true } on server ack.
   */
  async emitHeartbeat(timeoutMs = 350): Promise<{ ok: boolean; code?: string }> {
    if (!this.socket || !this.socket.connected) {
      throw new Error("Socket not connected");
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error("Heartbeat ack timeout"));
        }
      }, timeoutMs);

      try {
        this.socket!.emit("heartbeat", {}, (response: any) => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            if (response && response.ok === false) {
              reject(new Error(response.code || "Heartbeat rejected"));
            } else {
              resolve(response ?? { ok: true });
            }
          }
        });
      } catch (err) {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(err);
        }
      }
    });
  }

  /**
   * Emits e-stop assertion or clear over socket with ack.
   */
  async emitEstop(
    asserted: boolean,
    timeoutMs = 2000
  ): Promise<{ ok: boolean; code?: string; delivered: boolean; reason?: string }> {
    if (!this.socket || !this.socket.connected) {
      throw new Error("Socket not connected");
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error("E-stop emit timeout"));
        }
      }, timeoutMs);

      try {
        this.socket!.emit("estop", { asserted }, (response: any) => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve(response ?? { ok: true, delivered: true });
          }
        });
      } catch (err) {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(err);
        }
      }
    });
  }

  disconnect() {
    setRoverSocketConnected(false);
    setProdSocketConnected(false);
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.disconnect();
      this.socket = null;
    }
    this.setStatus("disconnected");
  }

  destroy() {
    this.disconnect();
    if (this.appStateSubscription) {
      this.appStateSubscription.remove();
      this.appStateSubscription = null;
    }
    this.listeners.clear();
  }

  getSocket(): Socket | null {
    return this.socket;
  }
}

// Global singleton instance
let globalProdSocket: ProdSocketManager | null = null;

export function getProdSocketManager(): ProdSocketManager {
  if (!globalProdSocket) {
    globalProdSocket = new ProdSocketManager();
  }
  return globalProdSocket;
}
