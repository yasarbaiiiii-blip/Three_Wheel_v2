/**
 * DYX 3WD rover discovery by UDP beacon (backend contract section 1a).
 *
 * Every second the rover sends {"type":"dyx3_beacon","v":1,"rover_id","rover_name","ip","port"} to the
 * broadcast address of each network it is on (site router, Jetson hotspot; never the FCU link). The app
 * listens on UDP 5003 and so learns, within about a second and with no fixed IP, which rovers are on the
 * tablet's current network and at which address. The rover is identified by rover_id, so the saved token
 * follows the rover across networks.
 *
 * Ported from the 4WD app (DYX_GCS_Frontend beaconListener, UDP 5002). The 3WD uses its own port and
 * type so the two products never mix. A beacon is a discovery hint only: connecting still goes through
 * HTTP /api/ping and the token check.
 */

import { Platform } from "react-native";

let dgram: any = null;
if (Platform.OS !== "web") {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    dgram = require("react-native-udp");
  } catch (error) {
    console.warn("[RoverBeacon] react-native-udp not available:", error);
  }
}

export const DYX3_BEACON_PORT = 5003;
/** Beacons arrive every 1 s; a rover not heard for this long is no longer listed. */
export const BEACON_FRESH_MS = 4000;

export interface BeaconRover {
  roverId: string;
  roverName: string;
  ip: string;
  port: number;
  /** http://ip:port, the backend base URL on the tablet's current network. */
  host: string;
  lastSeen: number;
}

function isIpv4(value: string): boolean {
  const parts = value.split(".");
  return (
    parts.length === 4 &&
    parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)
  );
}

/**
 * Parses one datagram. The address is the datagram's source (what is actually reachable from this
 * tablet); the payload ip is only a fallback. Returns null for anything that is not a valid 3WD beacon.
 */
export function parseDyx3Beacon(raw: string, senderIp: string, now: number): BeaconRover | null {
  let msg: any;
  try {
    msg = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!msg || msg.type !== "dyx3_beacon" || msg.v !== 1) return null;
  const roverId = typeof msg.rover_id === "string" ? msg.rover_id.trim() : "";
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(roverId)) return null;
  const port = Number(msg.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  const ip = isIpv4(senderIp) ? senderIp : typeof msg.ip === "string" && isIpv4(msg.ip) ? msg.ip : "";
  if (!ip) return null;
  const roverName =
    typeof msg.rover_name === "string" && msg.rover_name.trim() ? msg.rover_name.trim().slice(0, 64) : roverId;
  return { roverId, roverName, ip, port, host: `http://${ip}:${port}`, lastSeen: now };
}

export type BeaconListenerCallback = (rovers: BeaconRover[]) => void;

class RoverBeaconListener {
  private rovers = new Map<string, BeaconRover>();
  private socket: any = null;
  private loggedFirstBeacon = false;
  private subscribers = new Set<BeaconListenerCallback>();
  private pruneTimer: ReturnType<typeof setInterval> | null = null;

  get isAvailable(): boolean {
    return dgram !== null && Platform.OS !== "web";
  }

  /** Fresh rovers, sorted by name. */
  list(now = Date.now()): BeaconRover[] {
    return Array.from(this.rovers.values())
      .filter((r) => now - r.lastSeen <= BEACON_FRESH_MS)
      .sort((a, b) => a.roverName.localeCompare(b.roverName));
  }

  find(roverId: string): BeaconRover | null {
    const r = this.rovers.get(roverId);
    return r && Date.now() - r.lastSeen <= BEACON_FRESH_MS ? r : null;
  }

  findByHost(host: string): BeaconRover | null {
    const key = host.trim().replace(/\/+$/, "").toLowerCase();
    return this.list().find((r) => r.host.toLowerCase() === key) ?? null;
  }

  /** Starts listening (idempotent) and returns an unsubscribe function. */
  subscribe(cb: BeaconListenerCallback): () => void {
    this.subscribers.add(cb);
    this.start();
    cb(this.list());
    return () => {
      this.subscribers.delete(cb);
      if (this.subscribers.size === 0) this.stop();
    };
  }

  /** Test hook and socket path: feed one datagram. */
  ingest(raw: string, senderIp: string, now = Date.now()): void {
    const rover = parseDyx3Beacon(raw, senderIp, now);
    if (!rover) return;
    if (!this.loggedFirstBeacon) {
      this.loggedFirstBeacon = true;
      console.log("[RoverBeacon] first beacon:", rover.roverId, rover.host);
    }
    const prev = this.rovers.get(rover.roverId);
    this.rovers.set(rover.roverId, rover);
    if (!prev || prev.host !== rover.host || now - prev.lastSeen > BEACON_FRESH_MS) this.emit();
  }

  private emit(): void {
    const rovers = this.list();
    for (const cb of this.subscribers) {
      try {
        cb(rovers);
      } catch (err) {
        console.warn("[RoverBeacon] subscriber failed:", err);
      }
    }
  }

  private start(): void {
    if (!this.pruneTimer) {
      let lastCount = -1;
      this.pruneTimer = setInterval(() => {
        const n = this.list().length;
        if (n !== lastCount) {
          lastCount = n;
          this.emit();
        }
      }, 1000);
    }
    if (this.socket) return;
    if (!this.isAvailable) {
      console.warn("[RoverBeacon] UDP unavailable (dgram:", dgram !== null, "platform:", Platform.OS, ")");
      return;
    }
    try {
      console.log("[RoverBeacon] opening UDP", DYX3_BEACON_PORT);
      const socket = dgram.createSocket({ type: "udp4", reusePort: true, reuseAddr: true });
      socket.on("error", (err: Error) => console.warn("[RoverBeacon] UDP error:", String(err)));
      socket.on("message", (msg: { toString(): string }, rinfo: { address: string }) => {
        this.ingest(msg.toString(), rinfo?.address ?? "");
      });
      socket.bind(DYX3_BEACON_PORT, "0.0.0.0", () => {
        console.log("[RoverBeacon] listening on UDP", DYX3_BEACON_PORT);
      });
      this.socket = socket;
    } catch (error) {
      console.warn("[RoverBeacon] cannot listen on UDP", DYX3_BEACON_PORT, String(error));
      this.socket = null;
    }
  }

  private stop(): void {
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = null;
    }
    if (this.socket) {
      try {
        this.socket.close();
      } catch {
        // already closed
      }
      this.socket = null;
    }
  }
}

export const roverBeaconListener = new RoverBeaconListener();
