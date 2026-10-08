/**
 * Production Socket.IO Connection Manager (DYX_3WD)
 *
 * Rules:
 * 1. transports: ["websocket"] only.
 * 2. Handshake: auth: { token: string }.
 * 3. Automatic reconnect with exponential backoff.
 */

import { io, type Socket } from "socket.io-client";
import type { TelemetryPacket, GatewayEventPacket } from "../contract/prod/realtime";
import { applyProdTelemetrySnapshot, setProdGatewayConnected } from "../features/telemetry/prodTelemetryStore";

export type ProdSocketStatus = "disconnected" | "connecting" | "connected" | "error";
export type SocketStatusListener = (status: ProdSocketStatus, detail?: string) => void;

export class ProdSocketManager {
  private socket: Socket | null = null;
  private currentUrl = "";
  private currentToken: string | null = null;
  private status: ProdSocketStatus = "disconnected";
  private listeners = new Set<SocketStatusListener>();

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
            // Do not reject the entire flow if socket takes longer to handshake,
            // but log warning.
            console.warn("[ProdSocket] Socket connect taking longer than 10s...");
          }
        }, 10000);

        this.socket.on("connect", () => {
          clearTimeout(timer);
          this.setStatus("connected");
          if (!resolved) {
            resolved = true;
            resolve();
          }
        });

        this.socket.on("disconnect", (reason) => {
          this.setStatus("disconnected", String(reason));
          setProdGatewayConnected(false);
        });

        this.socket.on("connect_error", (err) => {
          const msg = err instanceof Error ? err.message : String(err);
          this.setStatus("error", msg);
          if (!resolved) {
            resolved = true;
            reject(err);
          }
        });

        // Inbound production events
        this.socket.on("telemetry", (packet: TelemetryPacket | string) => {
          try {
            let data: TelemetryPacket = typeof packet === "string" ? JSON.parse(packet) : packet;
            applyProdTelemetrySnapshot(data?.snapshot ?? null);
          } catch (e) {
            console.warn("[ProdSocket] Error parsing telemetry event:", e);
          }
        });

        this.socket.on("gateway", (packet: GatewayEventPacket | string) => {
          try {
            let data: GatewayEventPacket = typeof packet === "string" ? JSON.parse(packet) : packet;
            setProdGatewayConnected(Boolean(data?.connected));
          } catch (e) {
            console.warn("[ProdSocket] Error parsing gateway event:", e);
          }
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

  disconnect() {
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.disconnect();
      this.socket = null;
    }
    this.setStatus("disconnected");
    setProdGatewayConnected(false);
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
