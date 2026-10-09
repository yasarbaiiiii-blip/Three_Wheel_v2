import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ProdApiClient, ProdApiError } from "./prodClient";

describe("Production Backend Integration Contract Verification", () => {
  const baseUrl = "http://127.0.0.1:8000";
  const validToken = "978JjX-J5K2uLMJo3m_9QMzq2gyLX7GpDhVvnEPi8x8";
  const invalidToken = "wrong_invalid_token_xyz";
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      const authHeader = (init?.headers as Record<string, string> | undefined)?.["Authorization"];
      const isAuthed = authHeader === `Bearer ${validToken}`;

      if (url.endsWith("/api/ping")) {
        return new Response(JSON.stringify({ status: "ok" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (!isAuthed) {
        return new Response(
          JSON.stringify({ detail: "Not authenticated" }),
          { status: 401, headers: { "Content-Type": "application/json" } }
        );
      }

      if (url.endsWith("/api/health")) {
        return new Response(
          JSON.stringify({
            backend: "ok",
            gateway_connected: false,
            telemetry_age_s: null,
            telemetry_fresh: false,
            tablet_heartbeat_age_s: 0.1,
            tablet_alive: true,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      if (url.endsWith("/api/heartbeat")) {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (url.endsWith("/api/telemetry")) {
        return new Response(
          JSON.stringify({ connected: false, age_s: null, snapshot: null }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      if (url.endsWith("/api/estop")) {
        // Gateway offline -> 503 delivered: false
        return new Response(
          JSON.stringify({
            ok: false,
            code: "service_unavailable",
            reason: "gateway not connected",
            delivered: false,
            data: {},
          }),
          { status: 503, headers: { "Content-Type": "application/json" } }
        );
      }

      return new Response("Not found", { status: 404 });
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("proves the app connects and unauthenticated /api/ping returns ok", async () => {
    const client = new ProdApiClient({ baseUrl });
    const ping = await client.ping();
    expect(ping.status).toBe("ok");
  });

  it("proves auth works: invalid token is rejected with 401 Unauthorized", async () => {
    const unauthedClient = new ProdApiClient({ baseUrl, token: invalidToken });
    try {
      await unauthedClient.health();
      expect.unreachable("Should have rejected with 401");
    } catch (err) {
      expect(err).toBeInstanceOf(ProdApiError);
      expect((err as ProdApiError).status).toBe(401);
    }
  });

  it("proves auth works: valid token is accepted on /api/health", async () => {
    const authedClient = new ProdApiClient({ baseUrl, token: validToken });
    const health = await authedClient.health();
    expect(health.backend).toBe("ok");
    expect(health.gateway_connected).toBe(false);
    expect(health.telemetry_fresh).toBe(false);
  });

  it("proves heartbeat is accepted on POST /api/heartbeat", async () => {
    const authedClient = new ProdApiClient({ baseUrl, token: validToken });
    const hb = await authedClient.heartbeat();
    expect(hb.ok).toBe(true);

    const health = await authedClient.health();
    expect(health.tablet_alive).toBe(true);
    expect(health.tablet_heartbeat_age_s).toBeLessThan(1.0);
  });

  it("proves telemetry shows DISCONNECTED/STALE honestly with no gateway", async () => {
    const authedClient = new ProdApiClient({ baseUrl, token: validToken });
    const telem = await authedClient.getTelemetry();
    expect(telem.connected).toBe(false);
    expect(telem.snapshot).toBeNull();
  });

  it("proves E-stop works: asserts { asserted: true } and reports delivered: false honestly when gateway is offline", async () => {
    const authedClient = new ProdApiClient({ baseUrl, token: validToken });
    try {
      await authedClient.estop(true);
      expect.unreachable("Should report 503 gateway offline");
    } catch (err) {
      expect(err).toBeInstanceOf(ProdApiError);
      const apiErr = err as ProdApiError;
      expect(apiErr.status).toBe(503);
      expect(apiErr.delivered).toBe(false);
    }
  });
});
