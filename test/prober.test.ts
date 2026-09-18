import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Prober } from "../src/prober";

afterEach(() => vi.restoreAllMocks());

const ask = (body: unknown) => new Request("https://prober/run", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const inside = async (run: (prober: Prober) => Promise<Response>) => {
  const id = env.PROBER.idFromName("weur");
  return runInDurableObject(env.PROBER.get(id), (instance: Prober) => run(instance));
};

describe("the one place we measure from", () => {
  it("answers about every check it was given, in the order it was given them", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response("", {
      status: String(url).includes("broken") ? 503 : 200,
    })));

    const response = await inside((prober) => prober.fetch(ask({
      checks: [
        { type: "http", url: "https://broken.test/" },
        { type: "http", url: "https://fine.test/" },
        { type: "http", url: "https://also-fine.test/" },
      ],
      timeoutMs: 5000,
      attempts: 1,
    })));

    const { outcomes } = await response.json() as { outcomes: { ok: boolean }[] };
    // The caller pairs these with its projects by position, so an answer that
    // arrives reordered would report one service's health against another's
    // name — the one failure mode on this page worse than no answer at all.
    expect(outcomes.map((outcome) => outcome.ok)).toEqual([false, true, true]);
  });

  it("retries a failing check inside the tick, and stops once it passes", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      calls += 1;
      return new Response("", { status: calls === 1 ? 503 : 200 });
    }));

    const response = await inside((prober) => prober.fetch(ask({
      checks: [{ type: "http", url: "https://flaky.test/" }],
      timeoutMs: 5000,
      attempts: 3,
    })));

    const { outcomes } = await response.json() as { outcomes: { ok: boolean }[] };
    expect(outcomes[0]).toMatchObject({ ok: true });
    expect(calls).toBe(2);
  });

  it("refuses a body it cannot read rather than reporting on nothing", async () => {
    const response = await inside((prober) => prober.fetch(ask({ nothing: true })));
    expect(response.status).toBe(400);
  });
});
