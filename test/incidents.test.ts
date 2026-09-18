import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { openIncident, readIncidents, readOpenRequest, readUpdateRequest, trackIncidents, writeUpdate } from "../src/incidents";
import type { Announcement } from "../src/store";

const down = (projectId: string): Announcement => ({ projectId, from: "up", to: "down", detail: "Timed out" });
const up = (projectId: string): Announcement => ({ projectId, from: "down", to: "up", detail: null });

const now = 1_700_000_000_000;

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM incident_updates"),
    env.DB.prepare("DELETE FROM incidents"),
  ]);
});

describe("what the probes decide", () => {
  it("opens one when a project is called down, and only one", async () => {
    await trackIncidents(env, [down("alpha")], now);
    // The same transition seen twice — a retry, a tick replayed — must not
    // leave two open incidents for one outage.
    await trackIncidents(env, [down("alpha")], now + 60_000);

    const open = await readIncidents(env, now + 60_000);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ projectId: "alpha", startedAt: now, endedAt: null, handling: "investigating" });
  });

  it("closes one nobody wrote in, because a blip at four in the morning is not an incident", async () => {
    await trackIncidents(env, [down("alpha")], now);
    await trackIncidents(env, [up("alpha")], now + 180_000);

    const [incident] = await readIncidents(env, now + 180_000);
    expect(incident).toMatchObject({ endedAt: now + 180_000, handling: "resolved" });
    // And it is gone from the page a day later.
    expect(await readIncidents(env, now + 180_000 + 2 * 86_400_000)).toHaveLength(0);
  });

  it("leaves one somebody is writing in open, even once the checks pass", async () => {
    await trackIncidents(env, [down("alpha")], now);
    const [opened] = await readIncidents(env, now);
    await writeUpdate(env, opened!.id, { handling: "identified", cause: "cloudflare", body: "Their edge, not ours.", author: "me@example.test" }, now + 60_000);

    await trackIncidents(env, [up("alpha")], now + 120_000);

    const [incident] = await readIncidents(env, now + 120_000);
    // The service answers again and the page says so, but what is being done
    // about it is still what the person last said it was.
    expect(incident).toMatchObject({ endedAt: now + 120_000, handling: "identified", cause: "cloudflare" });
  });

  it("keeps one project's outage out of another's", async () => {
    await trackIncidents(env, [down("alpha"), down("beta")], now);
    await trackIncidents(env, [up("alpha")], now + 60_000);

    const open = await readIncidents(env, now + 60_000);
    expect(open.filter((incident) => incident.endedAt === null).map((incident) => incident.projectId)).toEqual(["beta"]);
  });
});

describe("what a person writes", () => {
  it("carries the handling and the cause onto the incident, and keeps every word in order", async () => {
    await trackIncidents(env, [down("alpha")], now);
    const [opened] = await readIncidents(env, now);
    await writeUpdate(env, opened!.id, { body: "Looking.", author: "me@example.test" }, now + 60_000);
    await writeUpdate(env, opened!.id, { handling: "monitoring", cause: "aws", body: "Failed over.", author: "me@example.test" }, now + 120_000);

    const [incident] = await readIncidents(env, now + 120_000);
    expect(incident).toMatchObject({ handling: "monitoring", cause: "aws" });
    expect(incident!.updates.map((update) => update.body)).toEqual(["Looking.", "Failed over."]);
    expect(incident!.updates[1]).toMatchObject({ handling: "monitoring", author: "me@example.test" });
  });

  it("can resolve one the probes still call down, because living with it is an answer", async () => {
    await trackIncidents(env, [down("alpha")], now);
    const [opened] = await readIncidents(env, now);
    await writeUpdate(env, opened!.id, { handling: "resolved", body: "Known, and we are living with it.", author: "me@example.test" }, now + 60_000);

    const [incident] = await readIncidents(env, now + 60_000);
    expect(incident).toMatchObject({ handling: "resolved", endedAt: null });
  });

  it("refuses an empty word and an incident that does not exist", async () => {
    await trackIncidents(env, [down("alpha")], now);
    const [opened] = await readIncidents(env, now);

    expect(await writeUpdate(env, opened!.id, { body: "   ", author: "me@example.test" }, now)).toBe(false);
    expect(await writeUpdate(env, 9999, { body: "Hello?", author: "me@example.test" }, now)).toBe(false);
    expect((await readIncidents(env, now))[0]!.updates).toHaveLength(0);
  });
});

describe("what the admin page may ask for", () => {
  it("takes a body, and a handling and a cause it recognises", () => {
    expect(readUpdateRequest({ body: "Looking." })).toMatchObject({ body: "Looking." });
    expect(readUpdateRequest({ body: "x", handling: "identified", cause: "aws" }))
      .toMatchObject({ handling: "identified", cause: "aws" });
  });

  it("refuses anything else, rather than storing a state nothing can render", () => {
    expect(readUpdateRequest({ body: "x", handling: "on fire" })).toBeNull();
    expect(readUpdateRequest({ body: "x", cause: "gremlins" })).toBeNull();
    expect(readUpdateRequest({ handling: "identified" })).toBeNull();
    expect(readUpdateRequest("nope")).toBeNull();
    expect(readUpdateRequest(null)).toBeNull();
  });
});

describe("what a person opens", () => {
  const said = { body: "Logins are slow, not down.", author: "me@example.test" };

  it("opens one for a service the probes are perfectly happy with", async () => {
    const id = await openIncident(env, { projectId: "alpha", ...said }, now);

    const [incident] = await readIncidents(env, now);
    expect(id).not.toBeNull();
    expect(incident).toMatchObject({ projectId: "alpha", startedAt: now, endedAt: null, handling: "investigating" });
    expect(incident!.updates[0]).toMatchObject({ body: said.body, author: said.author });
  });

  it("adds to the incident already open rather than failing or making a second", async () => {
    await trackIncidents(env, [down("alpha")], now);
    const [machine] = await readIncidents(env, now);

    const id = await openIncident(env, { projectId: "alpha", ...said }, now + 60_000);

    expect(id).toBe(machine!.id);
    const open = await readIncidents(env, now + 60_000);
    expect(open).toHaveLength(1);
    expect(open[0]!.updates).toHaveLength(1);
  });

  it("survives the checks passing, because a person opened it", async () => {
    await openIncident(env, { projectId: "alpha", ...said }, now);
    // The probe never called this one down, but it may well call it up.
    await trackIncidents(env, [up("alpha")], now + 120_000);

    const [incident] = await readIncidents(env, now + 120_000);
    expect(incident).toMatchObject({ handling: "investigating" });
  });

  it("refuses an empty word, so an incident is never opened saying nothing", async () => {
    expect(await openIncident(env, { projectId: "alpha", body: "  ", author: "me@example.test" }, now)).toBeNull();
    expect(await readIncidents(env, now)).toHaveLength(0);
  });

  it("needs a project named, and still refuses a handling it cannot render", () => {
    expect(readOpenRequest({ projectId: "alpha", body: "x" })).toMatchObject({ projectId: "alpha", body: "x" });
    expect(readOpenRequest({ body: "x" })).toBeNull();
    expect(readOpenRequest({ projectId: "", body: "x" })).toBeNull();
    expect(readOpenRequest({ projectId: "alpha", body: "x", handling: "on fire" })).toBeNull();
  });
});
