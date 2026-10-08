/**
 * Single Production App Transport Service (DYX_3WD)
 *
 * One transport for the whole app:
 * - Coordinates ProdSocketManager (realtime) and ProdApiClient (REST).
 * - Manages the fixed-rate HeartbeatScheduler (500 ms fixed cadence, 350 ms timeout).
 * - Priority: Socket.IO "heartbeat" event, fallback to REST POST /api/heartbeat.
 * - Handles 401 / unauthorized termination and honest status propagation.
 * - Manages secure storage for host & bearer token.
 */

import {
  getProdSocketManager,
  ProdSocketManager,
  type ProdSocketStatus,
  type SocketStatusListener,
} from "../api/prodSocket";
import {
  getProdApiClient,
  initProdApiClient,
  normalizeProdBaseUrl,
  ProdApiClient,
} from "../api/prodClient";
import {
  loadProdHost,
  loadProdToken,
  saveProdHost,
  saveProdToken,
} from "../api/prodStorage";
import {
  HeartbeatScheduler,
  type HeartbeatMetrics,
  type MetricsListener,
} from "../utils/heartbeatScheduler";
import {
  clearProdTelemetry,
} from "../features/telemetry/prodTelemetryStore";

export class AppTransportService {
  private socketMgr: ProdSocketManager;
  private client: ProdApiClient;
  private heartbeatScheduler: HeartbeatScheduler;
  private activeHost: string = "http://192.168.42.1:8000";
  private activeToken: string | null = null;
  private connectionListeners = new Set<SocketStatusListener>();

  constructor() {
    this.socketMgr = getProdSocketManager();
    this.client = getProdApiClient();

    // Fixed-rate heartbeat sender (independent of request latency)
    this.heartbeatScheduler = new HeartbeatScheduler(async () => {
      const socket = this.socketMgr.getSocket();
      if (socket && socket.connected) {
        try {
          const res = await this.socketMgr.emitHeartbeat(350);
          return { ok: Boolean(res.ok), transport: "socket" };
        } catch {
          // Socket heartbeat failed or timed out, attempt REST fallback
        }
      }

      try {
        const res = await this.client.heartbeat();
        return { ok: Boolean(res.ok), transport: "rest" };
      } catch {
        return { ok: false, transport: "none" };
      }
    }, 500);

    // Listen to socket status transitions
    this.socketMgr.subscribeStatus((status, detail) => {
      if (status === "connected") {
        this.heartbeatScheduler.start();
      } else if (status === "disconnected" || status === "unauthorized" || status === "error") {
        this.heartbeatScheduler.stop();
        if (status === "unauthorized") {
          clearProdTelemetry();
        }
      }
      this.notifyListeners(status, detail);
    });
  }

  private notifyListeners(status: ProdSocketStatus, detail?: string) {
    this.connectionListeners.forEach((l) => {
      try {
        l(status, detail);
      } catch (err) {
        console.warn("[AppTransport] listener error:", err);
      }
    });
  }

  subscribeStatus(listener: SocketStatusListener): () => void {
    this.connectionListeners.add(listener);
    listener(this.socketMgr.getStatus());
    return () => {
      this.connectionListeners.delete(listener);
    };
  }

  subscribeHeartbeat(listener: MetricsListener): () => void {
    return this.heartbeatScheduler.subscribe(listener);
  }

  getHeartbeatMetrics(): HeartbeatMetrics {
    return this.heartbeatScheduler.getMetrics();
  }

  getStatus(): ProdSocketStatus {
    return this.socketMgr.getStatus();
  }

  getClient(): ProdApiClient {
    return this.client;
  }

  getSocketManager(): ProdSocketManager {
    return this.socketMgr;
  }

  getActiveHost(): string {
    return this.activeHost;
  }

  getActiveToken(): string | null {
    return this.activeToken;
  }

  /**
   * Initializes stored settings on app startup.
   */
  async loadSavedCredentials(): Promise<{ host: string; token: string | null }> {
    const host = await loadProdHost();
    const token = await loadProdToken();
    this.activeHost = host;
    this.activeToken = token;
    this.client.setBaseUrl(host);
    this.client.setToken(token);
    return { host, token };
  }

  /**
   * Connects to a production rover via REST client + Socket.IO.
   * Caches credentials securely.
   */
  async connect(rawHost: string, token: string | null): Promise<void> {
    const normalizedHost = normalizeProdBaseUrl(rawHost);
    this.activeHost = normalizedHost;
    this.activeToken = token?.trim() || null;

    // Save to SecureStore
    await saveProdHost(normalizedHost);
    await saveProdToken(this.activeToken);

    // Initialize REST client
    this.client = initProdApiClient(normalizedHost, this.activeToken);

    // Connect Socket.IO
    await this.socketMgr.connect(normalizedHost, this.activeToken);
  }

  /**
   * Disconnects the rover session completely.
   */
  disconnect() {
    this.heartbeatScheduler.stop();
    this.socketMgr.disconnect();
    clearProdTelemetry();
  }

  /**
   * Logs out and clears stored token.
   */
  async logout(): Promise<void> {
    this.disconnect();
    this.activeToken = null;
    await saveProdToken(null);
    this.client.setToken(null);
  }
}

// Global singleton
let globalTransportService: AppTransportService | null = null;

export function getAppTransport(): AppTransportService {
  if (!globalTransportService) {
    globalTransportService = new AppTransportService();
  }
  return globalTransportService;
}
