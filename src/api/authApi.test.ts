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
});
