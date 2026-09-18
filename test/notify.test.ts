import { afterEach, describe, expect, it, vi } from "vitest";

import { announce } from "../src/notify";
import type { Env, Project } from "../src/types";

const projects: Project[] = [{ id: "alpha", name: "Alpha", check: { type: "http", url: "https://example.test/" } }];
const change = [{ projectId: "alpha", from: "up" as const, to: "down" as const, detail: "Timed out" }];

afterEach(() => vi.restoreAllMocks());

describe("channels", () => {
  it("sends nothing when nothing is configured", async () => {
    const sent = vi.fn();
    vi.stubGlobal("fetch", sent);
    await announce({} as Env, change, projects);
    expect(sent).not.toHaveBeenCalled();
  });

  it("uses every channel whose secrets are present", async () => {
    const sent = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", sent);
    const env = {
      TELEGRAM_BOT_TOKEN: "token",
      TELEGRAM_CHAT_ID: "42",
      ALERT_WEBHOOK_URL: "https://hooks.test/inbox",
    } as Env;

    await announce(env, change, projects);

    expect(sent).toHaveBeenCalledTimes(2);
    const targets = sent.mock.calls.map((call) => String(call[0]));
    expect(targets.some((url) => url.includes("api.telegram.org"))).toBe(true);
    expect(targets).toContain("https://hooks.test/inbox");
  });

  it("names the project and its reason, and says when it recovers", async () => {
    const bodies: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(String(init.body));
      return new Response("{}", { status: 200 });
    }));
    const env = { ALERT_WEBHOOK_URL: "https://hooks.test/inbox" } as Env;

    await announce(env, change, projects);
    expect(bodies[0]).toContain("Alpha is down: Timed out");

    await announce(env, [{ projectId: "alpha", from: "down", to: "up", detail: null }], projects);
    expect(bodies[1]).toContain("Alpha is back up");
  });

  it("keeps going when one channel fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => (String(url).includes("telegram")
      ? new Response("no", { status: 500 })
      : new Response("{}", { status: 200 }))));
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const env = { TELEGRAM_BOT_TOKEN: "t", TELEGRAM_CHAT_ID: "1", ALERT_WEBHOOK_URL: "https://hooks.test/inbox" } as Env;
    await expect(announce(env, change, projects)).resolves.toBeUndefined();
  });
});
