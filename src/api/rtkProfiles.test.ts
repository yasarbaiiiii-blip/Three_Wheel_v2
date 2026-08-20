import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildNtripProfileUpdate,
  createNtripProfile,
  listNtripProfiles,
  NtripProfileConflictError,
  updateNtripProfile,
} from "./rtkProfiles";

vi.mock("react-native", () => ({ Platform: { OS: "web" } }));

describe("rtkProfiles API", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("sends a write-only password only in the request and never adds its own token source", async () => {
    const fetchSpy = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response("{}", { status: 201 })
    );
    globalThis.fetch = fetchSpy as typeof fetch;

    await createNtripProfile(
      "http://192.168.1.102:5001",
      {
        name: "Main caster",
        host: "caster.example.com",
        port: 2101,
        mountpoint: "ROVER",
        username: "operator",
        password: "replacement-secret",
      },
      4
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy.mock.calls[0] as [RequestInfo | URL, RequestInit?];
    expect(JSON.parse(String(init?.body))).toEqual({
      name: "Main caster",
      host: "caster.example.com",
      port: 2101,
      mountpoint: "ROVER",
      username: "operator",
      password: "replacement-secret",
    });
    expect(new Headers(init?.headers).has("X-Rover-Token")).toBe(false);
    expect(new Headers(init?.headers).get("If-Match")).toBe('"4"');
  });

  it("receives X-Rover-Token from the existing global authenticated fetch", async () => {
    const wireFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ profiles: [] }), { status: 200 })
    );
    globalThis.fetch = wireFetch as typeof fetch;
    const authApi = await import("./authApi");
    authApi.installAuthenticatedFetch();
    authApi.setAuthRuntime({
      token: "rover-session-token",
      baseUrl: "http://192.168.1.102:5001",
    });

    await listNtripProfiles("http://192.168.1.102:5001");

    const [, init] = wireFetch.mock.calls[0] as [RequestInfo | URL, RequestInit?];
    expect(new Headers(init?.headers).get("X-Rover-Token")).toBe("rover-session-token");
    authApi.setAuthRuntime({ token: null, baseUrl: null });
  });

  it("drops password-like fields from list responses", async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      registry_revision: 2,
      default_profile_id: "profile-1",
      active_profile_id: null,
      profiles: [{
        id: "profile-1",
        revision: 1,
        name: "Main",
        host: "caster.example.com",
        port: 2101,
        mountpoint: "MP",
        username: "user",
        password_configured: true,
        password: "must-not-escape",
        pass: "must-not-escape-either",
      }],
    }), { status: 200 })) as typeof fetch;

    const registry = await listNtripProfiles("http://192.168.1.102:5001");
    expect(registry.profiles[0]).not.toHaveProperty("password");
    expect(registry.profiles[0]).not.toHaveProperty("pass");
    expect(JSON.stringify(registry)).not.toContain("must-not-escape");
  });

  it("preserves schema metadata and sanitizes migration warnings", async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      schema_version: 1,
      registry_revision: 1,
      default_profile_id: null,
      active_profile_id: null,
      migration_warning: "Legacy config imported\nverify then remove old file\u0000",
      profiles: [],
    }), { status: 200 })) as typeof fetch;

    const registry = await listNtripProfiles("http://192.168.1.102:5001");
    expect(registry.schema_version).toBe(1);
    expect(registry.migration_warning).toBe("Legacy config imported verify then remove old file");
  });

  it("omits a blank edit password so the backend retains the saved secret", async () => {
    expect(buildNtripProfileUpdate({ name: "Renamed", password: "" })).toEqual({ name: "Renamed" });

    const fetchSpy = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response("{}", { status: 200 })
    );
    globalThis.fetch = fetchSpy as typeof fetch;
    await updateNtripProfile(
      "http://192.168.1.102:5001",
      "profile/one",
      { name: "Renamed", password: "" },
      8
    );
    const [url, init] = fetchSpy.mock.calls[0] as [RequestInfo | URL, RequestInit?];
    expect(String(url)).toContain("profile%2Fone");
    expect(JSON.parse(String(init?.body))).toEqual({ name: "Renamed" });
  });

  it("surfaces revision conflicts distinctly", async () => {
    globalThis.fetch = vi.fn(async () => new Response(
      JSON.stringify({ detail: "profile registry changed; current revision is 9" }),
      { status: 409 }
    )) as typeof fetch;

    await expect(
      updateNtripProfile("http://192.168.1.102:5001", "profile-1", { name: "Renamed" }, 8)
    ).rejects.toBeInstanceOf(NtripProfileConflictError);
  });

  it("times out a hung rover profile request", async () => {
    globalThis.fetch = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          });
        })
    ) as typeof fetch;

    await expect(listNtripProfiles("http://192.168.1.102:5001", 10)).rejects.toThrow(
      /did not respond in time/
    );
  });
});
