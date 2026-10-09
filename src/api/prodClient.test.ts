import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  ProdApiClient,
  normalizeProdBaseUrl,
  ProdApiError,
  DEFAULT_PROD_PORT,
} from "./prodClient";

describe("Production REST Client - prodClient", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("normalizes base URL to default port 8000", () => {
    expect(normalizeProdBaseUrl("192.168.42.1")).toBe("http://192.168.42.1:8000");
    expect(normalizeProdBaseUrl("http://192.168.42.1")).toBe("http://192.168.42.1:8000");
    expect(normalizeProdBaseUrl("http://192.168.42.1:8000")).toBe("http://192.168.42.1:8000");
    expect(normalizeProdBaseUrl("http://rover.local:9000/")).toBe("http://rover.local:9000");
    expect(normalizeProdBaseUrl("https://rover.company.com")).toBe("https://rover.company.com:8000");
  });

  it("attaches Authorization: Bearer token header", async () => {
    let capturedHeaders: HeadersInit | undefined;
    globalThis.fetch = vi.fn().mockImplementation(async (_url, init) => {
      capturedHeaders = init?.headers;
      return new Response(JSON.stringify({ backend: "ok", gateway_connected: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const client = new ProdApiClient({
      baseUrl: "http://192.168.42.1:8000",
      token: "secret_token_123",
    });

    const health = await client.health();
    expect(health.backend).toBe("ok");
    expect((capturedHeaders as Record<string, string>)["Authorization"]).toBe("Bearer secret_token_123");
  });

  it("omits Authorization header on /api/ping", async () => {
    let capturedHeaders: HeadersInit | undefined;
    globalThis.fetch = vi.fn().mockImplementation(async (_url, init) => {
      capturedHeaders = init?.headers;
      return new Response(JSON.stringify({ status: "ok" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const client = new ProdApiClient({
      baseUrl: "http://192.168.42.1:8000",
      token: "secret_token_123",
    });

    await client.ping();
    expect((capturedHeaders as Record<string, string>)["Authorization"]).toBeUndefined();
  });

  it("sends exact E-stop payload { asserted: true } and { asserted: false }", async () => {
    let capturedBody: string | undefined;
    let capturedMethod: string | undefined;
    globalThis.fetch = vi.fn().mockImplementation(async (_url, init) => {
      capturedMethod = init?.method;
      capturedBody = init?.body as string;
      return new Response(JSON.stringify({ ok: true, code: "ok", reason: "", delivered: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const client = new ProdApiClient({ baseUrl: "http://192.168.42.1:8000", token: "tok" });

    // Assert
    await client.estop(true);
    expect(capturedMethod).toBe("POST");
    expect(JSON.parse(capturedBody!)).toEqual({ asserted: true });

    // Clear
    await client.estop(false);
    expect(capturedMethod).toBe("POST");
    expect(JSON.parse(capturedBody!)).toEqual({ asserted: false });
  });

  it("does not automatically retry failed POST requests", async () => {
    const fetchSpy = vi.fn().mockImplementation(async () => {
      return new Response(
        JSON.stringify({ ok: false, code: "service_unavailable", reason: "Gateway offline", delivered: false }),
        { status: 503, headers: { "Content-Type": "application/json" } }
      );
    });
    globalThis.fetch = fetchSpy;

    const client = new ProdApiClient({ baseUrl: "http://192.168.42.1:8000", token: "tok" });

    await expect(client.arm(true)).rejects.toThrow("Gateway offline");
    // Strictly called ONCE - no retry loop!
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("parses and propagates downstream gateway error responses verbatim", async () => {
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      return new Response(
        JSON.stringify({
          ok: false,
          code: "rejected",
          reason: "ARM_DISALLOWED_ESTOP_ACTIVE",
          delivered: true,
          data: { accepted: false, reason_code: 5 },
        }),
        { status: 409, headers: { "Content-Type": "application/json" } }
      );
    });

    const client = new ProdApiClient({ baseUrl: "http://192.168.42.1:8000", token: "tok" });

    try {
      await client.arm(true);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ProdApiError);
      const apiErr = err as ProdApiError;
      expect(apiErr.status).toBe(409);
      expect(apiErr.code).toBe("rejected");
      expect(apiErr.reason).toBe("ARM_DISALLOWED_ESTOP_ACTIVE");
      expect(apiErr.delivered).toBe(true);
      expect(apiErr.data).toEqual({ accepted: false, reason_code: 5 });
    }
  });
});
