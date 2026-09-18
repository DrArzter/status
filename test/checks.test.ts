import { afterEach, describe, expect, it, vi } from "vitest";

import { runCheck } from "../src/checks";
import { fetchWithTiming } from "../src/checks/http";
import { settings } from "../src/config";

const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

afterEach(() => vi.restoreAllMocks());

describe("http", () => {
  it("passes on the expected status and fails on any other", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 200 })));
    expect(await runCheck({ type: "http", url: "https://example.test/" }, 5000)).toMatchObject({ ok: true });

    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 503 })));
    expect(await runCheck({ type: "http", url: "https://example.test/" }, 5000)).toMatchObject({ ok: false, detail: "HTTP 503, expected 200" });
  });

  it("starts its clock at the request, not when the probe was called", async () => {
    // The guard is the yield: until the probe has given up its turn, nothing
    // has gone out. Without it the request is issued in the same synchronous
    // step as the reading, and on a Worker — where the clock only moves with
    // I/O — that reading is the invocation's start rather than the request's.
    let issued = false;
    vi.stubGlobal("fetch", vi.fn(async () => { issued = true; return new Response("", { status: 200 }); }));

    const pending = fetchWithTiming("https://example.test/", 5000);
    expect(issued).toBe(false);

    const { ms } = await pending;
    expect(issued).toBe(true);
    expect(ms).toBeGreaterThanOrEqual(0);
  });

  it("reports a thrown request as a failed check, not a failed tick", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("boom"); }));
    expect(await runCheck({ type: "http", url: "https://example.test/" }, 5000)).toMatchObject({ ok: false, detail: "boom" });
  });
});

describe("json", () => {
  it("compares a value at a dotted path", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => answer({ data: { state: "ok" } })));
    const check = { type: "json", url: "https://example.test/health", path: "data.state", equals: "ok" } as const;
    expect(await runCheck(check, 5000)).toMatchObject({ ok: true });

    vi.stubGlobal("fetch", vi.fn(async () => answer({ data: { state: "degraded" } })));
    expect(await runCheck(check, 5000)).toMatchObject({ ok: false });
  });
});

describe("heartbeat", () => {
  const check = { type: "heartbeat", url: "https://example.test/last", path: "lastRun", withinMinutes: 60 } as const;

  it("passes while the last run is recent enough", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => answer({ lastRun: new Date(Date.now() - 10 * 60_000).toISOString() })));
    expect(await runCheck(check, 5000)).toMatchObject({ ok: true });
  });

  it("fails once it is stale, and says how stale", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => answer({ lastRun: new Date(Date.now() - 180 * 60_000).toISOString() })));
    const outcome = await runCheck(check, 5000);
    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain("180 min ago");
  });

  it("accepts epoch seconds as well as an ISO string", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => answer({ lastRun: Math.floor((Date.now() - 60_000) / 1000) })));
    expect(await runCheck(check, 5000)).toMatchObject({ ok: true });
  });
});

describe("settings", () => {
  it("falls back to shipped defaults and clamps nonsense", () => {
    expect(settings({} as never)).toMatchObject({ attempts: 2, failuresBeforeDown: 3, timeoutMs: 8000 });
    expect(settings({ FAILURES_BEFORE_DOWN: "0", PROBE_ATTEMPTS: "99", PROBE_TIMEOUT_MS: "nonsense" } as never))
      .toMatchObject({ failuresBeforeDown: 1, attempts: 5, timeoutMs: 8000 });
  });
});
