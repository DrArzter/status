import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { settings } from "../src/config";
import { catchUp, claimTransitions, foldNow, GRAIN, readBuckets, readLatest, rollUp, writeResults } from "../src/store";
import type { Project } from "../src/types";

const project: Project = { id: "alpha", name: "Alpha", check: { type: "http", url: "https://example.test/" } };
const config = settings({ ...env, FAILURES_BEFORE_DOWN: "3" });

const hour = 3_600_000;
const day = 86_400_000;

async function record(at: number, ok: boolean, ms = 120, detail?: string): Promise<void> {
  await writeResults(env, at, [{ project, outcome: detail === undefined ? { ok, ms } : { ok, ms, detail } }]);
}

/** The buckets that actually hold checks, out of the whole window handed over. */
const measuredIn = (byProject: Map<string, ReadonlyArray<{ checks: number }>>) =>
  (byProject.get(project.id) ?? []).filter((bucket) => bucket.checks > 0);

/** Wraps a database so a test can assert what a read cost, from D1's own count. */
function countingReads(database: D1Database) {
  let rows = 0;
  const wrapped = {
    prepare: (sql: string) => database.prepare(sql),
    batch: async (statements: D1PreparedStatement[]) => {
      const answers = await database.batch(statements);
      for (const answer of answers) rows += answer.meta.rows_read ?? 0;
      return answers;
    },
  } as unknown as D1Database;
  return { db: wrapped, rowsRead: () => rows };
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM checks"),
    env.DB.prepare("DELETE FROM quarter_hourly"),
    env.DB.prepare("DELETE FROM hourly"),
    env.DB.prepare("DELETE FROM daily"),
    env.DB.prepare("DELETE FROM announced"),
  ]);
});

describe("state from a window of checks", () => {
  it("stays up while failures are shorter than the run that declares an outage", async () => {
    const now = Date.now();
    await record(now - 120_000, true);
    await record(now - 60_000, false, 8000, "Timed out");
    await record(now, false, 8000, "Timed out");

    const latest = await readLatest(env, config, [project]);
    expect(latest.get("alpha")?.state).toBe("up");
  });

  it("goes down once the whole window has failed", async () => {
    const now = Date.now();
    await record(now - 120_000, false, 8000, "Timed out");
    await record(now - 60_000, false, 8000, "Timed out");
    await record(now, false, 8000, "Timed out");

    const latest = await readLatest(env, config, [project]);
    expect(latest.get("alpha")).toMatchObject({ state: "down", detail: "Timed out" });
  });

  it("is unknown when nothing has been recorded", async () => {
    const latest = await readLatest(env, config, [project]);
    expect(latest.get("alpha")).toBeUndefined();
  });

  it("costs the window it asks for, not the history it keeps", async () => {
    // D1 bills rows read. The query this replaced numbered every row in
    // `checks` before the outer filter could drop one, so a probe a minute and
    // an open tab together spent the daily free allowance many times over; a
    // reading of the last few checks must not grow with the retention.
    const beta: Project = { id: "beta", name: "Beta", check: { type: "http", url: "https://example.test/" } };
    const now = Date.now();
    const insert = env.DB.prepare("INSERT INTO checks (project_id, at, ok, ms, detail) VALUES (?, ?, ?, ?, ?)");
    await env.DB.batch(Array.from({ length: 600 }, (_, index) => insert.bind(
      index % 2 === 0 ? "alpha" : "beta", now - index * 60_000, 1, 120, null,
    )));

    const counted = countingReads(env.DB);
    const latest = await readLatest({ DB: counted.db } as unknown as typeof env, config, [project, beta]);

    expect(latest.get("alpha")?.state).toBe("up");
    expect(latest.get("beta")?.state).toBe("up");
    expect(counted.rowsRead()).toBeLessThanOrEqual(2 * config.failuresBeforeDown);
  });

  it("reports only the projects it was asked about", async () => {
    const now = Date.now();
    await record(now, true);
    await env.DB.prepare("INSERT INTO checks (project_id, at, ok, ms, detail) VALUES (?, ?, ?, ?, ?)")
      .bind("retired", now, 0, 8000, "Timed out").run();

    // An id dropped from the catalogue keeps its rows until the retention
    // forgets them, and must not go on raising alerts from behind.
    const latest = await readLatest(env, config, [project]);
    expect(latest.has("retired")).toBe(false);
  });
});

describe("alerts", () => {
  it("announces a change once, and again only when it changes back", async () => {
    const now = Date.now();
    for (const offset of [180_000, 120_000, 60_000]) await record(now - offset, false, 8000, "Timed out");

    const down = await claimTransitions(env, await readLatest(env, config, [project]), now);
    expect(down).toEqual([{ projectId: "alpha", from: "unknown", to: "down", detail: "Timed out" }]);

    const repeat = await claimTransitions(env, await readLatest(env, config, [project]), now);
    expect(repeat).toEqual([]);

    await record(now + 60_000, true);
    const up = await claimTransitions(env, await readLatest(env, config, [project]), now + 60_000);
    expect(up).toEqual([{ projectId: "alpha", from: "down", to: "up", detail: null }]);
  });
});

describe("catching the grains up", () => {
  it("folds the hour that is still running, so the week window reaches now", async () => {
    // The window views read `hourly`; before this ran hourly they were blind to
    // everything probed since the nightly pass, and the page drew those hours
    // as unmeasured when they had in fact been measured every minute.
    const now = Math.floor(Date.now() / hour) * hour + 20 * 60_000;
    for (const minute of [1, 2, 3]) await record(now - minute * 60_000, true, 100);

    await catchUp(env, now);

    const hours = await env.DB.prepare("SELECT hour, checks FROM hourly").all<{ hour: number; checks: number }>();
    expect(hours.results).toHaveLength(1);
    expect(hours.results[0]).toMatchObject({ hour: now - 20 * 60_000, checks: 3 });

    const days = await env.DB.prepare("SELECT day, checks FROM daily").all<{ day: string; checks: number }>();
    expect(days.results[0]?.checks).toBe(3);
  });

  it("is safe to run again, and takes the newer answer for an hour still filling", async () => {
    const now = Math.floor(Date.now() / hour) * hour + 20 * 60_000;
    await record(now - 60_000, true, 100);
    await catchUp(env, now);
    await record(now - 30_000, false, 8000, "Timed out");
    await catchUp(env, now);

    const hours = await env.DB.prepare("SELECT checks, failures FROM hourly").all<{ checks: number; failures: number }>();
    expect(hours.results).toHaveLength(1);
    expect(hours.results[0]).toMatchObject({ checks: 2, failures: 1 });
  });

  it("reads only the hours it was asked to cover, not the whole retention", async () => {
    const now = Math.floor(Date.now() / hour) * hour + 20 * 60_000;
    // Ten hours of history behind the window, and three checks inside it. In
    // one batch: six hundred round trips is the test itself timing out, not the
    // thing under test being slow.
    const insert = env.DB.prepare("INSERT INTO checks (project_id, at, ok, ms, detail) VALUES (?, ?, ?, ?, ?)");
    await env.DB.batch(Array.from({ length: 600 }, (_unused, index) =>
      insert.bind(project.id, now - 3 * hour - (index + 1) * 60_000, 1, 100, null)));
    for (const minute of [1, 2, 3]) await record(now - minute * 60_000, true, 100);

    const counted = countingReads(env.DB);
    await catchUp({ DB: counted.db } as unknown as typeof env, now, 1);
    // The cover is one hour, so the ten hours of rows behind it are not read.
    expect(counted.rowsRead()).toBeLessThan(100);
  });
});

describe("the number the page calls a median", () => {
  it("is one: a single slow answer does not move it", async () => {
    const bucket = Math.floor(Date.now() / (15 * 60_000)) * (15 * 60_000);
    for (let minute = 0; minute < 14; minute += 1) await record(bucket + minute * 60_000, true, 100);
    // One four-second answer, of the kind a network has every so often.
    await record(bucket + 14 * 60_000, true, 4000);
    await foldNow(env, bucket + 15 * 60_000);

    const folded = await env.DB.prepare("SELECT checks, p50_ms, p95_ms FROM quarter_hourly").first<{ checks: number; p50_ms: number; p95_ms: number }>();
    expect(folded?.checks).toBe(15);
    // An average would read 360 here and the card would say the service slowed
    // down by a factor of three. The middle answer did not move.
    expect(folded?.p50_ms).toBe(100);
    expect(folded?.p95_ms).toBe(4000);
  });

  it("is one for the bucket still filling, which is read straight from the checks", async () => {
    const bucket = Math.floor(Date.now() / (15 * 60_000)) * (15 * 60_000);
    for (const [minute, ms] of [[0, 100], [1, 110], [2, 4000], [3, 105], [4, 95]] as const) {
      await record(bucket + minute * 60_000, true, ms);
    }

    const buckets = measuredIn(await readBuckets(env, "day", bucket + 5 * 60_000, [project]));
    expect(buckets).toHaveLength(1);
    expect(buckets[0]).toMatchObject({ checks: 5, p50_ms: 105 });
  });
});

describe("folding a quarter hour once", () => {
  it("writes nothing while the bucket is still filling", async () => {
    const bucket = Math.floor(Date.now() / (15 * 60_000)) * (15 * 60_000);
    await record(bucket + 60_000, true, 100);

    // Five minutes in, and five minutes after that: the same open bucket, so
    // there is nothing to write down that will not change again.
    await foldNow(env, bucket + 5 * 60_000);
    await foldNow(env, bucket + 10 * 60_000);

    const folded = await env.DB.prepare("SELECT count(*) AS total FROM quarter_hourly").first<{ total: number }>();
    expect(folded?.total).toBe(0);
  });

  it("writes it when the bucket closes, and not again after", async () => {
    const bucket = Math.floor(Date.now() / (15 * 60_000)) * (15 * 60_000);
    for (const minute of [1, 2, 3]) await record(bucket + minute * 60_000, true, 100);

    // The first probe of the next bucket is the crossing.
    await foldNow(env, bucket + 15 * 60_000);
    const first = await env.DB.prepare("SELECT at, checks FROM quarter_hourly").all<{ at: number; checks: number }>();
    expect(first.results).toHaveLength(1);
    expect(first.results[0]).toMatchObject({ at: bucket, checks: 3 });

    const counted = countingReads(env.DB);
    await foldNow({ DB: counted.db } as unknown as typeof env, bucket + 16 * 60_000);
    expect(counted.rowsRead()).toBe(0);
  });

  it("shows the open bucket anyway, read from the raw rows behind it", async () => {
    const bucket = Math.floor(Date.now() / (15 * 60_000)) * (15 * 60_000);
    await record(bucket - 10 * 60_000, true, 100);
    await foldNow(env, bucket);
    for (const minute of [1, 2]) await record(bucket + minute * 60_000, false, 8000, "Timed out");

    // Nothing has folded the bucket in progress, and the window still has it:
    // the closed ones come from the grain, the open one from the raw table.
    const buckets = measuredIn(await readBuckets(env, "day", bucket + 3 * 60_000, [project]));
    expect(buckets).toHaveLength(2);
    expect(buckets[1]).toMatchObject({ at: bucket, checks: 2, failures: 2 });
  });
});

describe("what a window costs to answer", () => {
  it("answers the day from a couple of hundred rows, not from the whole raw table", async () => {
    // The reason this grain exists. Grouping a day of per-minute checks read
    // about nine thousand rows an answer, and one browser tab left open asks
    // once a minute — which is the daily allowance gone before lunch.
    const now = Math.floor(Date.now() / hour) * hour;
    const insert = env.DB.prepare("INSERT INTO checks (project_id, at, ok, ms, detail) VALUES (?, ?, ?, ?, ?)");
    for (let chunk = 0; chunk < 3; chunk += 1) {
      await env.DB.batch(Array.from({ length: 960 }, (_unused, index) =>
        insert.bind(project.id, now - (chunk * 960 + index) * 60_000, 1, 100, null)));
    }
    await rollUp(env, now, { ...config, rawRetentionDays: 7, hourlyRetentionDays: 90 });

    const counted = countingReads(env.DB);
    const buckets = await readBuckets({ DB: counted.db } as unknown as typeof env, "day", now, [project]);

    expect(measuredIn(buckets).length).toBeGreaterThan(80);
    expect(counted.rowsRead()).toBeLessThan(400);
  });
});

describe("rollups and retention", () => {
  it("folds finished hours and days, and drops the raw rows behind them", async () => {
    // Anchored half past the hour, so the pair below cannot straddle a bucket
    // boundary and the recent row cannot fall behind one: on a bare clock this
    // failed whenever the minute happened to land near the hour.
    const now = Math.floor(Date.now() / hour) * hour + 30 * 60_000;
    await record(now - 3 * day - hour, true, 100);
    await record(now - 3 * day - hour + 60_000, false, 300, "HTTP 500");
    await record(now - 30 * 60_000, true, 110);

    await rollUp(env, now, { ...config, rawRetentionDays: 2, hourlyRetentionDays: 90 });

    const hours = await env.DB.prepare("SELECT checks, failures FROM hourly").all<{ checks: number; failures: number }>();
    expect(hours.results[0]).toMatchObject({ checks: 2, failures: 1 });

    const days = await env.DB.prepare("SELECT checks, failures FROM daily").all<{ checks: number; failures: number }>();
    expect(days.results[0]).toMatchObject({ checks: 2, failures: 1 });

    // The old raw rows are gone; the recent one, inside the retention, is not.
    const raw = await env.DB.prepare("SELECT count(*) AS total FROM checks").first<{ total: number }>();
    expect(raw?.total).toBe(1);
  });
});

describe("windows", () => {
  it("answers the day from quarter hours and the quarter from days", async () => {
    const now = Date.now();
    await record(now - 20 * 60_000, true, 100);
    await catchUp(env, now);
    await env.DB.prepare("INSERT INTO daily (project_id, day, checks, failures, p50_ms, p95_ms) VALUES ('alpha', date(?/1000,'unixepoch'), 1440, 12, 130, 400)")
      .bind(now - 10 * day).run();

    const today = await readBuckets(env, "day", now, [project]);
    expect(measuredIn(today)).toHaveLength(1);

    const quarter = await readBuckets(env, "quarter", now, [project]);
    expect(measuredIn(quarter)[0]).toMatchObject({ checks: 1440, failures: 12 });
  });

  it("hands over the whole window, so a short history is not stretched across it", async () => {
    const now = Date.now();
    await record(now - 20 * 60_000, true, 100);

    // A project watched for twenty minutes still answers with a day of
    // buckets. The page draws one bar per bucket, so without this the few it
    // has would spread over the width and read as a full day of history.
    for (const range of ["day", "week", "month", "quarter", "year"] as const) {
      const buckets = (await readBuckets(env, range, now, [project])).get(project.id) ?? [];
      const expected = Math.round(GRAIN[range].span / GRAIN[range].bucket) + 1;
      expect(buckets).toHaveLength(expected);
      expect(buckets.every((bucket, index) => index === 0 || bucket.at - buckets[index - 1]!.at === GRAIN[range].bucket)).toBe(true);
      expect(buckets.filter((bucket) => bucket.checks === 0).length).toBeGreaterThan(0);
    }
  });

  it("keeps the bucket the window opens inside, rather than dropping it whole", async () => {
    // A rolled-up row is stamped with the start of its bucket. Asking for
    // everything at or after `now - a day` therefore threw away the bucket that
    // instant falls inside — fifteen minutes of checks, drawn as though nothing
    // had been measured, at the left of the strip for as long as the page was up.
    const bucket = 15 * 60_000;
    const edge = Math.floor(Date.now() / bucket) * bucket;
    const now = edge + day + 7 * 60_000;
    for (const minute of [2, 6, 11]) await record(edge + minute * 60_000, true, 100);
    await catchUp(env, edge + bucket);

    const buckets = (await readBuckets(env, "day", now, [project])).get(project.id) ?? [];
    expect(buckets[0]).toMatchObject({ at: edge, checks: 3 });
  });

  it("answers for a project that has never been checked at all", async () => {
    const now = Date.now();
    const fresh: Project = { id: "brand-new", name: "Brand new", check: { type: "http", url: "https://example.test/" } };

    const buckets = (await readBuckets(env, "week", now, [fresh])).get(fresh.id) ?? [];
    expect(buckets.length).toBeGreaterThan(0);
    expect(buckets.every((bucket) => bucket.checks === 0 && bucket.failures === 0)).toBe(true);
  });
});

describe("bars are grouped at the window's grain", () => {
  it("folds a day of per-minute checks into quarter-hour bars", async () => {
    // Anchored to a bar boundary, so the count is the grain and not the clock.
    const now = Math.floor(Date.now() / 900_000) * 900_000;
    // Forty-five minutes of probes, one a minute: three bars, fifteen each.
    for (let minute = 1; minute <= 45; minute += 1) await record(now - minute * 60_000, true);
    // The day window reads the folded grain, so the fold is part of the path.
    await catchUp(env, now);

    const buckets = measuredIn(await readBuckets(env, "day", now, [project]));
    expect(buckets).toHaveLength(3);
    expect(buckets.every((bucket) => bucket.checks === 15)).toBe(true);
    // The trap this guards: `checks` has its own `at` column, so an alias named
    // `at` makes SQLite group by the raw row and hand back every check as a bar.
    const spacing = buckets.slice(1).map((bucket, index) => bucket.at - buckets[index]!.at);
    expect(spacing.every((gap) => gap === 900_000)).toBe(true);
  });

  it("folds hours into eight-hour bars for the month window", async () => {
    const now = Date.now();
    const base = Math.floor(now / (8 * hour)) * (8 * hour);
    for (let back = 1; back <= 16; back += 1) {
      await env.DB.prepare("INSERT INTO hourly VALUES (?, ?, ?, ?, ?, ?)")
        .bind(project.id, base - back * hour, 60, 0, 100, 300).run();
    }

    const buckets = measuredIn(await readBuckets(env, "month", now, [project]));
    expect(buckets).toHaveLength(2);
    expect(buckets.every((bucket) => bucket.checks === 480)).toBe(true);
  });

  it("keeps every window at about ninety bars, so the strip has one density", async () => {
    const now = Date.now();
    for (const [range, expected] of [["day", 96], ["week", 84], ["month", 90], ["quarter", 90], ["year", 90]] as const) {
      expect(Math.round(GRAIN[range].span / GRAIN[range].bucket)).toBe(expected);
    }
    expect(now).toBeGreaterThan(0);
  });
});
