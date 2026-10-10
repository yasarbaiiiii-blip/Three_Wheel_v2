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
  loadProdTokenForRover,
  saveLastRoverId,
  saveProdHost,
  saveProdTokenFor,
  saveProdTokenForRover,
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
  private activeHost: string = "";
  private activeRoverId: string | null = null;
  private activeToken: string | null = null;
  private connectionListeners = new Set<SocketStatusListener>();
  private appStateSubscription: NativeEventSubscription | null = null;
  /** True from the first accepted socket connection until disconnect()/unauthorized. */
  private sessionActive = false;
  private appActive = true;

  constructor() {
    this.socketMgr = getProdSocketManager();
    this.client = getProdApiClient();

    // Fixed-rate heartbeat sender (independent of request latency). ONE path per tick:
    // the socket while it is connected, REST only while the socket is down. Never both: a late
    // socket ack must not add a second request, and a down socket must not silence the heartbeat.
    this.heartbeatScheduler = new HeartbeatScheduler(async () => {
      const socket = this.socketMgr.getSocket();
      if (socket && socket.connected) {
        try {
          const res = await this.socketMgr.emitHeartbeat(HEARTBEAT_REQUEST_TIMEOUT_MS);
          return { ok: Boolean(res.ok), transport: "socket" };
        } catch {
          return { ok: false, transport: "socket" };
        }
      }
      try {
        const res = await this.client.heartbeat({ timeoutMs: HEARTBEAT_REQUEST_TIMEOUT_MS });
        return { ok: Boolean(res.ok), transport: "rest" };
      } catch {
        return { ok: false, transport: "rest" };
      }
    }, 500);

    // The heartbeat follows the operator SESSION, not the socket status: a reconnect window
    // ("disconnected"/"error" while socket.io retries) must not stop it (no stop/start churn);
    // the sender switches to REST for that window. It stops only when the session ends.
    this.socketMgr.subscribeStatus((status, detail) => {
      if (status === "connected") {
        this.sessionActive = true;
        if (this.appActive) this.heartbeatScheduler.start();
      } else if (status === "unauthorized") {
        this.sessionActive = false;
        this.heartbeatScheduler.stop();
        clearProdTelemetry();
      }
      this.notifyListeners(status, detail);
    });

    this.setupAppStateListener();
  }

  private setupAppStateListener() {
    try {
      if (AppState && typeof AppState.addEventListener === "function") {
        this.appStateSubscription = AppState.addEventListener("change", (nextState) => {
          if (nextState === "background") {
            // Tablet sleep / background: JS timers are not reliable there; pause cleanly.
            this.appActive = false;
            this.heartbeatScheduler.stop();
          } else if (nextState === "active") {
            // Foregrounded: resume at once while the session is alive (socket state is irrelevant:
            // the sender uses REST until the socket is back).
            this.appActive = true;
            if (this.sessionActive) {
              this.heartbeatScheduler.start();
              this.heartbeatScheduler.triggerNow();
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

  getActiveRoverId(): string | null {
    return this.activeRoverId;
  }

  /** The token saved for this rover: by rover id when known (works on every network), else by address. */
  async getSavedTokenFor(rawHost: string, roverId?: string | null): Promise<string | null> {
    const host = normalizeProdBaseUrl(rawHost);
    if (roverId) return loadProdTokenForRover(roverId, host || undefined);
    return host ? loadProdTokenFor(host) : null;
  }

  /** Forgets the saved token for this rover only (other rovers keep theirs). */
  async forgetSavedToken(rawHost: string, roverId?: string | null): Promise<void> {
    const normalizedHost = normalizeProdBaseUrl(rawHost);
    if (roverId) await saveProdTokenForRover(roverId, null);
    if (normalizedHost) await saveProdTokenFor(normalizedHost, null);
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
    // A new session: no heartbeat to the old rover/token while this one is being accepted.
    this.sessionActive = false;
    this.heartbeatScheduler.stop();

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

    // Key the token by rover identity too, so it works when this rover is reached on another network.
    this.activeRoverId = null;
    try {
      const ping = await this.client.ping();
      const roverId = typeof ping?.rover_id === "string" ? ping.rover_id.trim() : "";
      if (roverId) {
        this.activeRoverId = roverId;
        await saveProdTokenForRover(roverId, this.activeToken);
        await saveLastRoverId(roverId);
      }
    } catch {
      // Older backend without rover_id: the address-keyed token still works.
    }
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
    this.sessionActive = false;
    this.heartbeatScheduler.stop();
    this.socketMgr.disconnect();
    clearProdTelemetry();
  }

  /**
   * Disconnects and forgets the saved token for the active rover.
   */
  async logout(): Promise<void> {
    this.disconnect();
    await this.forgetSavedToken(this.activeHost, this.activeRoverId);
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
