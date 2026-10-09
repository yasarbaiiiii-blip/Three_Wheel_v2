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
  loadProdTokenFor,
  saveProdHost,
  saveProdTokenFor,
} from "../api/prodStorage";
import {
  HeartbeatScheduler,
  type HeartbeatMetrics,
  type MetricsListener,
  HEARTBEAT_REQUEST_TIMEOUT_MS,
} from "../utils/heartbeatScheduler";
import {
  clearProdTelemetry,
} from "../features/telemetry/prodTelemetryStore";
import { setAuthRuntime, installAuthenticatedFetch } from "../api/authApi";
import { AppState, type NativeEventSubscription } from "react-native";

export class AppTransportService {
  private socketMgr: ProdSocketManager;
  private client: ProdApiClient;
  private heartbeatScheduler: HeartbeatScheduler;
  private activeHost: string = "http://192.168.42.1:8000";
  private activeToken: string | null = null;
  private connectionListeners = new Set<SocketStatusListener>();
  private appStateSubscription: NativeEventSubscription | null = null;

  constructor() {
    this.socketMgr = getProdSocketManager();
    this.client = getProdApiClient();

    // Fixed-rate heartbeat sender (independent of request latency)
    // Total budget capped strictly at 350 ms (< 500 ms)
    this.heartbeatScheduler = new HeartbeatScheduler(async () => {
      const socket = this.socketMgr.getSocket();
      if (socket && socket.connected) {
        try {
          // Socket heartbeat allocated 200 ms
          const res = await this.socketMgr.emitHeartbeat(200);
          return { ok: Boolean(res.ok), transport: "socket" };
        } catch {
          // Socket heartbeat failed or timed out: REST fallback allocated remaining 150 ms
        }
        try {
          const res = await this.client.heartbeat({ timeoutMs: 150 });
          return { ok: Boolean(res.ok), transport: "rest" };
        } catch {
          return { ok: false };
        }
      }

      // Socket disconnected: REST given full 350 ms budget
      try {
        const res = await this.client.heartbeat({ timeoutMs: HEARTBEAT_REQUEST_TIMEOUT_MS });
        return { ok: Boolean(res.ok), transport: "rest" };
      } catch {
        return { ok: false };
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

    this.setupAppStateListener();
  }

  private setupAppStateListener() {
    try {
      if (AppState && typeof AppState.addEventListener === "function") {
        this.appStateSubscription = AppState.addEventListener("change", (nextState) => {
          if (nextState === "background" || nextState === "inactive") {
            // Tablet sleep / background: pause heartbeat scheduler cleanly
            this.heartbeatScheduler.stop();
          } else if (nextState === "active") {
            // Tablet wake-up / foregrounded: check socket and immediately trigger heartbeat
            if (this.socketMgr.getStatus() === "connected") {
              this.heartbeatScheduler.start();
              this.heartbeatScheduler.triggerNow();
            } else if (this.activeToken) {
              void this.socketMgr.connect(this.activeHost, this.activeToken);
            }
          }
        });
      }
    } catch {
      // Unit test runner / non-RN environments
    }
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
    const token = await loadProdTokenFor(normalizeProdBaseUrl(host));
    this.activeHost = host;
    this.activeToken = token;
    this.client.setBaseUrl(host);
    this.client.setToken(token);
    return { host, token };
  }

  /** The token saved for this rover address, or null. */
  async getSavedTokenFor(rawHost: string): Promise<string | null> {
    return loadProdTokenFor(normalizeProdBaseUrl(rawHost));
  }

  /** Forgets the saved token for this rover only (other rovers keep theirs). */
  async forgetSavedToken(rawHost: string): Promise<void> {
    const normalizedHost = normalizeProdBaseUrl(rawHost);
    await saveProdTokenFor(normalizedHost, null);
    if (normalizedHost === this.activeHost) {
      this.activeToken = null;
      this.client.setToken(null);
      setAuthRuntime({ token: null, baseUrl: null });
    }
  }

  /**
   * Connects to a production rover via REST client + Socket.IO.
   * The host is saved at once; the token is saved for this rover only after the rover accepts it,
   * so a mistyped token is never remembered.
   */
  async connect(rawHost: string, token: string | null): Promise<void> {
    const normalizedHost = normalizeProdBaseUrl(rawHost);
    this.activeHost = normalizedHost;
    this.activeToken = token?.trim() || null;

    await saveProdHost(normalizedHost);

    // Initialize REST client
    this.client = initProdApiClient(normalizedHost, this.activeToken);

    // Sync token to authApi runtime so any fetch() calls include the Bearer token
    try {
      installAuthenticatedFetch();
      setAuthRuntime({
        token: this.activeToken,
        baseUrl: normalizedHost,
      });
    } catch {
      // ignore
    }

    // Connect Socket.IO (resolves only after the rover accepted the token)
    await this.socketMgr.connect(normalizedHost, this.activeToken);
    await saveProdTokenFor(normalizedHost, this.activeToken);
  }

  /**
   * Emergency stop: triggers via Socket.IO for minimal latency, and also
   * dispatches REST POST /api/estop as a dual-path safety guarantee.
   * Throws an error if NEITHER transport delivers the command to the rover.
   */
  async estop(asserted = true): Promise<void> {
    let delivered = false;
    let lastError: Error | null = null;

    const socketPromise = (async () => {
      try {
        const res = await this.socketMgr.emitEstop(asserted, 400);
        if (res && res.ok !== false) delivered = true;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        console.warn("[AppTransport] Socket estop warning:", err);
      }
    })();

    const restPromise = (async () => {
      try {
        const res = await this.client.estop(asserted);
        if (res && res.ok !== false) delivered = true;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        console.warn("[AppTransport] REST estop warning:", err);
      }
    })();

    await Promise.allSettled([socketPromise, restPromise]);

    if (!delivered) {
      const errDetail = lastError ? (lastError as Error).message : "";
      throw new Error(
        `E-stop command (${asserted ? "ASSERT" : "CLEAR"}) failed to reach rover across both Socket.IO and REST transports. ${errDetail}`
      );
    }
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
   * Disconnects and forgets the saved token for the active rover.
   */
  async logout(): Promise<void> {
    this.disconnect();
    await this.forgetSavedToken(this.activeHost);
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
