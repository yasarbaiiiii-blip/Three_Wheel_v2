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

    expect(seen[0].token).toBe("session-token");
    expect(seen[1].token).toBeNull();
    expect(invalid).toHaveBeenCalledTimes(1);

    globalThis.fetch = original;
  });

  it("routes a 403 password_change_required to its own handler, not the 401 path", async () => {
    // While the rover is on its bootstrap password EVERY endpoint answers 403.
    // Treating that as an invalid session would sign the operator out in a loop;
    // ignoring it would render 403 errors on every screen with no way forward.
    //
    // installAuthenticatedFetch guards on a module-level `originalFetch`, so a
    // second call in the same module instance is a no-op and the wrapper never
    // gets installed over this test's mock. Reset the registry for a fresh one.
    vi.resetModules();
    const authApi = await import("./authApi");
    const invalid = vi.fn();
    const rotate = vi.fn();
    const original = globalThis.fetch;

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/locked")) {
        return new Response(
          JSON.stringify({
            detail: { code: "password_change_required", message: "..." },
          }),
          { status: 403, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.includes("/api/forbidden")) {
        return new Response(JSON.stringify({ detail: "Not allowed" }), { status: 403 });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    authApi.installAuthenticatedFetch();
    authApi.setAuthRuntime({
      token: "t",
      baseUrl: "http://192.168.1.102:5001",
      onInvalidSession: invalid,
      onPasswordChangeRequired: rotate,
    });

    const locked = await fetch("http://192.168.1.102:5001/api/locked");
    expect(rotate).toHaveBeenCalledTimes(1);
    expect(invalid).not.toHaveBeenCalled();

    // The interceptor reads a CLONE — the caller's body must still be readable.
    await expect(locked.json()).resolves.toMatchObject({
      detail: { code: "password_change_required" },
    });

    // An ordinary 403 must NOT force a password rotation.
    await fetch("http://192.168.1.102:5001/api/forbidden");
    expect(rotate).toHaveBeenCalledTimes(1);

    globalThis.fetch = original;
  });
});

describe("must_change_password normalisation", () => {
  it("carries the flag off a login response", async () => {
    const authApi = await import("./authApi");
    const original = globalThis.fetch;
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          token: "t",
          session_id: "s",
          expires_at: new Date(Date.now() + 60_000).toISOString(),
          ttl_s: 43200,
          must_change_password: true,
        }),
        { status: 200 }
      )
    ) as typeof fetch;

    const session = await authApi.login("http://192.168.1.102:5001", "pw");
    expect(session.must_change_password).toBe(true);

    globalThis.fetch = original;
  });

  it("defaults a missing flag to false, so rotation is never stuck on", async () => {
    // /api/auth/change-password does not echo the field — the rotation it just
    // performed is what clears the condition. If absent read as `true` the app
    // would sit on the mandatory screen forever after a SUCCESSFUL change.
    const authApi = await import("./authApi");
    const original = globalThis.fetch;
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          token: "new",
          session_id: "s2",
          expires_at: new Date(Date.now() + 60_000).toISOString(),
          ttl_s: 43200,
          revoked_sessions: 2,
        }),
        { status: 200 }
      )
    ) as typeof fetch;

    const session = await authApi.changePassword("http://192.168.1.102:5001", "old", "newpassword");
    expect(session.must_change_password).toBe(false);
    expect(session.token).toBe("new");

    globalThis.fetch = original;
  });
});

describe("authApi session helpers", () => {
  it("reuses only non-expired sessions for the same backend host", async () => {
    const authApi = await import("./authApi");
    const session = {
      token: "abc",
      session_id: "sid",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      ttl_s: 3600,
      baseUrl: "http://192.168.1.102:5001",
      must_change_password: false,
    };

    expect(authApi.canReuseSession(session, "http://192.168.1.102:5001/")).toBe(true);
    expect(authApi.canReuseSession(session, "http://192.168.1.103:5001")).toBe(false);
    expect(authApi.isSessionExpired({ ...session, expires_at: "2000-01-01T00:00:00Z" })).toBe(true);
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
