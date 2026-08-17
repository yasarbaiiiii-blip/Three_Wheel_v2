import { describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({ Platform: { OS: "web" } }));

describe("authApi authenticated fetch", () => {
  it("adds session token to protected rover calls and handles 401", async () => {
    const authApi = await import("./authApi");
    const seen: Array<{ url: string; token: string | null }> = [];
    const invalid = vi.fn();
    const original = globalThis.fetch;

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const headers = new Headers(init?.headers ?? {});
      seen.push({ url, token: headers.get("X-Rover-Token") });
      return new Response("{}", { status: url.includes("expired") ? 401 : 200 });
    }) as typeof fetch;

    authApi.installAuthenticatedFetch();
    authApi.setAuthRuntime({
      token: "session-token",
      baseUrl: "http://192.168.1.102:5001",
      onInvalidSession: invalid,
    });

    await fetch("http://192.168.1.102:5001/api/mission/status");
    await fetch("http://192.168.1.102:5001/api/auth/login", { method: "POST" });
    await fetch("http://192.168.1.102:5001/api/expired");
    await fetch("http://192.168.1.102:5001/api/expired-again");

    expect(seen[0].token).toBe("session-token");
    expect(seen[1].token).toBeNull();
    expect(invalid).toHaveBeenCalledTimes(1);
    expect(seen[3].token).toBeNull();

    globalThis.fetch = original;
  });

  it("does not let a throwing invalid-session handler break fetch", async () => {
    vi.resetModules();
    const authApi = await import("./authApi");
    const original = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => new Response("{}", { status: 401 })) as typeof fetch;

    authApi.installAuthenticatedFetch();
    authApi.setAuthRuntime({
      token: "session-token",
      baseUrl: "http://192.168.1.102:5001",
      onInvalidSession: () => {
        throw new Error("handler boom");
      },
    });

    const response = await fetch("http://192.168.1.102:5001/api/rpp/params");
    expect(response.status).toBe(401);

    globalThis.fetch = original;
  });
});

describe("authApi session helpers", () => {
  it("reuses sessions for the same backend host and ignores wall-clock expires_at", async () => {
    const authApi = await import("./authApi");
    const session = {
      token: "abc",
      session_id: "sid",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      ttl_s: 3600,
      baseUrl: "http://192.168.1.102:5001",
    };

    expect(authApi.canReuseSession(session, "http://192.168.1.102:5001/")).toBe(true);
    expect(authApi.canReuseSession(session, "http://192.168.1.103:5001")).toBe(false);
    // Client does not expire on local clock; backend 401 / auth_revoked is the authority.
    expect(authApi.isSessionExpired({ ...session, expires_at: "2000-01-01T00:00:00Z" })).toBe(false);
    expect(
      authApi.canReuseSession(
        { ...session, expires_at: "2000-01-01T00:00:00Z" },
        "http://192.168.1.102:5001"
      )
    ).toBe(true);
    expect(authApi.isSessionExpired(null)).toBe(true);
    expect(authApi.isSessionExpired({ ...session, token: "" })).toBe(true);
  });

  it("loadStoredSession keeps past expires_at tokens", async () => {
    const authApi = await import("./authApi");
    const pastSession = {
      token: "stored-token",
      session_id: "sid-past",
      expires_at: "2000-01-01T00:00:00Z",
      ttl_s: 3600,
      baseUrl: "http://192.168.1.102:5001",
    };
    const store = new Map<string, string>();
    const sessionStorageMock = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        store.set(k, v);
      },
      removeItem: (k: string) => {
        store.delete(k);
      },
    };
    vi.stubGlobal("sessionStorage", sessionStorageMock);

    sessionStorageMock.setItem("rover.operatorSession.v1", JSON.stringify(pastSession));
    const loaded = await authApi.loadStoredSession();
    expect(loaded?.token).toBe("stored-token");
    expect(loaded?.expires_at).toBe("2000-01-01T00:00:00Z");

    vi.unstubAllGlobals();
  });

  it("attaches baseUrl on login responses", async () => {
    const authApi = await import("./authApi");
    const original = globalThis.fetch;

    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          token: "new-token",
          session_id: "sid-1",
          expires_at: "2099-01-01T00:00:00Z",
          ttl_s: 3600,
        }),
        { status: 200 }
      )
    ) as typeof fetch;

    const session = await authApi.login("http://192.168.1.102:5001", "secret");
    expect(session.baseUrl).toBe("http://192.168.1.102:5001");
    expect(session.token).toBe("new-token");

    globalThis.fetch = original;
  });
});
