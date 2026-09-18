import type { Bucket, CheckOutcome, Env, Project, ProjectState, Range } from "./types";
import type { Settings } from "./config";

export type Written = { project: Project; outcome: CheckOutcome };

const HOUR = 3_600_000;
const DAY = 86_400_000;
const QUARTER_HOUR = 900_000;

/**
 * The folds pick a rank rather than averaging, because the column is called a
 * median and the page prints it as one. An average is not: a single four-second
 * answer among fifteen ordinary ones moved a bucket from 250 ms to 700 and made
 * a working service look sick, which is what this is here to stop.
 *
 * The rank is integer arithmetic on the count. `(total + 1) / 2` is the middle
 * of an odd run and the lower middle of an even one — SQLite truncates — and
 * `(total * 95 + 99) / 100` is the ninety-fifth percentile rounded up, which on
 * a quarter hour of checks lands on the slowest one or two. `max(CASE ...)`
 * plucks the row at that rank out of the group, since only one row matches.
 */

/** One batch per tick: a scheduled invocation has little CPU, so nothing else happens here. */
export async function writeResults(env: Env, at: number, results: readonly Written[]): Promise<void> {
  if (results.length === 0) return;
  const insert = env.DB.prepare("INSERT INTO checks (project_id, at, ok, ms, detail) VALUES (?, ?, ?, ?, ?)");
  await env.DB.batch(results.map(({ project, outcome }) => insert.bind(
    project.id,
    at,
    outcome.ok ? 1 : 0,
    outcome.ms,
    outcome.detail ?? null,
  )));
}

/**
 * Folds raw checks into quarter hours, over whatever span is asked for. This
 * grain is not a window anybody picks: it exists so the day window reads two
 * hundred rows instead of grouping a day of per-minute checks, which read
 * about nine thousand and put the daily allowance within reach of one open tab.
 */
const foldQuarterHours = (env: Env, since: number, until: number) => env.DB.prepare(`
  INSERT INTO quarter_hourly (project_id, at, checks, failures, p50_ms, p95_ms)
  WITH ranked AS (
    SELECT project_id, (at / 900000) * 900000 AS bucket_at, ms, ok,
           row_number() OVER (PARTITION BY project_id, (at / 900000) * 900000 ORDER BY ms) AS place,
           count(*) OVER (PARTITION BY project_id, (at / 900000) * 900000) AS total
      FROM checks WHERE at >= ? AND at < ?
  )
  SELECT project_id, bucket_at, max(total), sum(1 - ok),
         max(CASE WHEN place = (total + 1) / 2 THEN ms END),
         max(CASE WHEN place = (total * 95 + 99) / 100 THEN ms END)
    FROM ranked GROUP BY project_id, bucket_at
  ON CONFLICT (project_id, at) DO UPDATE SET
         checks = excluded.checks, failures = excluded.failures,
         p50_ms = excluded.p50_ms, p95_ms = excluded.p95_ms
`).bind(since, until);

/**
 * Folds a quarter hour once, when it closes, and not again.
 *
 * Called from the probe, because the day window is the one people watch to see
 * what is happening now and it cannot wait for an hourly job. But a bucket that
 * is still filling is not worth writing: folding every minute rewrote the same
 * row fifteen times and made writing, not reading, the budget that binds — and
 * writes are what grow with every project added. The window reads the bucket
 * that is still open straight from the raw rows instead, which is thirty of
 * them.
 *
 * Two buckets wide rather than one, so a crossing that was missed is made good
 * by the next one a quarter of an hour later rather than by the hourly pass.
 *
 * `previous` is when the probe last ran. A minute before now, in practice; the
 * argument exists so the crossing is a fact rather than an assumption about how
 * often the cron fires.
 */
export async function foldNow(env: Env, now: number, previous = now - 60_000): Promise<void> {
  const bucket = Math.floor(now / QUARTER_HOUR) * QUARTER_HOUR;
  if (Math.floor(previous / QUARTER_HOUR) * QUARTER_HOUR === bucket) return;
  await foldQuarterHours(env, bucket - 2 * QUARTER_HOUR, bucket).run();
}

/**
 * Folds raw checks into hours, over whatever span is asked for. An upsert, so
 * folding an hour that was already folded costs a few rows read and changes
 * nothing — which is what lets the same statement heal a missed pass and carry
 * an hour that has not finished yet.
 */
const foldHours = (env: Env, since: number, until: number) => env.DB.prepare(`
  INSERT INTO hourly (project_id, hour, checks, failures, p50_ms, p95_ms)
  WITH ranked AS (
    SELECT project_id, (at / 3600000) * 3600000 AS hour, checks, failures, p50_ms, p95_ms,
           row_number() OVER (PARTITION BY project_id, (at / 3600000) * 3600000 ORDER BY p50_ms) AS place,
           count(*) OVER (PARTITION BY project_id, (at / 3600000) * 3600000) AS total
      FROM quarter_hourly WHERE at >= ? AND at < ?
  )
  SELECT project_id, hour, sum(checks), sum(failures),
         max(CASE WHEN place = (total + 1) / 2 THEN p50_ms END),
         max(p95_ms)
    FROM ranked GROUP BY project_id, hour
  ON CONFLICT (project_id, hour) DO UPDATE SET
         checks = excluded.checks, failures = excluded.failures,
         p50_ms = excluded.p50_ms, p95_ms = excluded.p95_ms
`).bind(since, until);

/**
 * The same, one grain up: hours into days.
 *
 * Every grain above the finest folds the one below it rather than the raw
 * table. Ordering a group to find its middle is the expensive part, and doing
 * it over an hour of raw checks twenty-four times a day cost more than the
 * whole rest of the page put together. Only the quarter hour sees individual
 * checks; above it a median is the middle of the medians beneath, which is
 * what the daily grain has always done.
 */
const foldDays = (env: Env, since: number, until: number) => env.DB.prepare(`
  INSERT INTO daily (project_id, day, checks, failures, p50_ms, p95_ms)
  SELECT project_id, date(hour / 1000, 'unixepoch') AS day, sum(checks), sum(failures),
         cast(avg(p50_ms) AS int), cast(max(p95_ms) AS int)
    FROM hourly WHERE hour >= ? AND hour < ? GROUP BY project_id, day
  ON CONFLICT (project_id, day) DO UPDATE SET
         checks = excluded.checks, failures = excluded.failures,
         p50_ms = excluded.p50_ms, p95_ms = excluded.p95_ms
`).bind(since, until);

/**
 * Brings the rolled-up grains up to the minute, on the hour.
 *
 * The week and month windows are read from `hourly` and the longer ones from
 * `daily`, and those tables were filled once a night. Everything probed since
 * the last pass was therefore missing from them: a week window stopped six
 * hours short of now and drew the rest as unmeasured, which it was not. This
 * folds the hours that have passed since — the unfinished one included, so the
 * newest bar is the one happening — and today into `daily` for the same reason.
 *
 * Bounded on both sides. The tables it reads are billed by rows, and an
 * unbounded fold every hour would read the whole retention twenty-four times a
 * day to learn what changed in one of them.
 *
 * The quarter hours are covered for an hour rather than for four: the probe
 * folds them as they close and reaches a bucket back when it does, so this is
 * the second net and not the first. Reading raw checks to order them is the
 * dearest thing here, and four hours of it every hour cost more than every
 * other write and fold together.
 */
export async function catchUp(env: Env, now: number, coverHours = 4): Promise<void> {
  const hourStart = Math.floor(now / HOUR) * HOUR;
  const dayStart = Math.floor(now / DAY) * DAY;
  await env.DB.batch([
    foldQuarterHours(env, hourStart - HOUR, now),
    foldHours(env, hourStart - coverHours * HOUR, now),
    foldDays(env, dayStart - DAY, now),
  ]);
}

/**
 * The nightly pass: fold everything, then drop what is behind the retention
 * each grain keeps. Nothing expires on its own: D1 holds a row until it is
 * deleted, so retention is a decision made here rather than a platform's.
 */
export async function rollUp(env: Env, now: number, config: Settings): Promise<void> {
  const hourBoundary = Math.floor(now / HOUR) * HOUR;
  const dayBoundary = Math.floor(now / DAY) * DAY;
  await env.DB.batch([
    foldQuarterHours(env, 0, now),
    foldHours(env, 0, hourBoundary),
    foldDays(env, 0, dayBoundary),
    env.DB.prepare("DELETE FROM checks WHERE at < ?").bind(now - config.rawRetentionDays * DAY),
    env.DB.prepare("DELETE FROM hourly WHERE hour < ?").bind(now - config.hourlyRetentionDays * DAY),
    // The day window reaches back one day; the rest is room for a pass that
    // did not run. Two hundred rows a day, so the margin costs nothing.
    env.DB.prepare("DELETE FROM quarter_hourly WHERE at < ?").bind(now - 7 * DAY),
  ]);
}

/**
 * Which table answers a window, and how wide a bar is in it.
 *
 * Every window is cut to about ninety bars — 96, 84, 90, 90, 90 — so the strip
 * has one density rather than five. A day at ten-minute grain drew 144 and a
 * month at four-hour grain drew 180, and at those counts a bar is thinner than
 * the gap beside it and the strip reads as hatching. Precision is the thing
 * given up, and a status page is read for shape rather than for the minute.
 *
 * The bucket alias is `bucket_at`, never `at`: `checks` has a column of that
 * name, and SQLite resolves `GROUP BY at` to the column rather than to the
 * alias, which silently groups by the raw row and returns the window
 * ungrouped. The divisions are cast too, because a bound number can arrive as
 * REAL and float division does no flooring at all.
 */
export const GRAIN: Record<Range, { source: "quarter_hourly" | "hourly" | "daily"; span: number; bucket: number }> = {
  day: { source: "quarter_hourly", span: DAY, bucket: QUARTER_HOUR },
  week: { source: "hourly", span: 7 * DAY, bucket: 2 * HOUR },
  month: { source: "hourly", span: 30 * DAY, bucket: 8 * HOUR },
  quarter: { source: "daily", span: 90 * DAY, bucket: DAY },
  year: { source: "daily", span: 270 * DAY, bucket: 3 * DAY },
};

/** Days are kept as date strings, so reading them takes its own arithmetic. */
const dayBuckets = (env: Env, bucket: number, since: number) => env.DB.prepare(`
  SELECT project_id,
         cast(cast(strftime('%s', day) AS int) * 1000 / ? AS int) * ? AS bucket_at,
         sum(checks) AS checks, sum(failures) AS failures, cast(avg(p50_ms) AS int) AS p50_ms
    FROM daily WHERE cast(strftime('%s', day) AS int) * 1000 >= ?
   GROUP BY project_id, bucket_at ORDER BY bucket_at
`).bind(bucket, bucket, since);

/**
 * The hourly grain, read whole: every bucket in the window has closed, because
 * the window ends where the grain does.
 *
 * The table name is interpolated rather than bound because a table is not a
 * value and no placeholder can stand for one. It comes from `GRAIN` and from
 * nowhere else, which is what makes that safe.
 */
const hourBuckets = (env: Env, bucket: number, since: number) => env.DB.prepare(`
  SELECT project_id, cast(hour / ? AS int) * ? AS bucket_at,
         sum(checks) AS checks, sum(failures) AS failures, cast(avg(p50_ms) AS int) AS p50_ms
    FROM hourly WHERE hour >= ?
   GROUP BY project_id, bucket_at ORDER BY bucket_at
`).bind(bucket, bucket, since);

/**
 * The quarter-hour grain, up to the bucket that is still filling.
 *
 * Buckets are folded when they close, so the one in progress is not here. It is
 * read separately rather than in a union with this: joined into one statement,
 * SQLite stopped using the index on the raw table and read the lot — six
 * thousand rows where two hundred would do. Two statements in one batch is one
 * round trip and two index seeks.
 */
const quarterHourGrain = (env: Env, bucket: number, since: number, openFrom: number) => env.DB.prepare(`
  SELECT project_id, cast(at / ? AS int) * ? AS bucket_at,
         sum(checks) AS checks, sum(failures) AS failures, cast(avg(p50_ms) AS int) AS p50_ms
    FROM quarter_hourly WHERE at >= ? AND at < ?
   GROUP BY project_id, bucket_at ORDER BY bucket_at
`).bind(bucket, bucket, since, openFrom);

/**
 * The bucket in progress, from the raw rows: a quarter hour of them per project.
 *
 * Everything past `openFrom` is in that one bucket, so it is named rather than
 * computed and the grouping is by project alone. Grouping by the expression
 * instead cost the index: SQLite sorted the whole table rather than seeking the
 * handful of rows the range holds, and `INDEXED BY` is stated so a planner that
 * changes its mind cannot quietly bring that back.
 */
const quarterHourTail = (env: Env, openFrom: number) => env.DB.prepare(`
  WITH ranked AS (
    SELECT project_id, ms, ok,
           row_number() OVER (PARTITION BY project_id ORDER BY ms) AS place,
           count(*) OVER (PARTITION BY project_id) AS total
      FROM checks INDEXED BY checks_at WHERE at >= ?
  )
  SELECT project_id, ? AS bucket_at, max(total) AS checks, sum(1 - ok) AS failures,
         max(CASE WHEN place = (total + 1) / 2 THEN ms END) AS p50_ms
    FROM ranked GROUP BY project_id
`).bind(openFrom, openFrom);

/**
 * What answers this window. One statement for the coarser grains, two for the
 * finest: what has been folded, and the bucket that has not closed yet.
 */
function readersFor(env: Env, grain: (typeof GRAIN)[Range], since: number, now: number): D1PreparedStatement[] {
  if (grain.source === "daily") return [dayBuckets(env, grain.bucket, since)];
  if (grain.source === "hourly") return [hourBuckets(env, grain.bucket, since)];
  const openFrom = Math.floor(now / QUARTER_HOUR) * QUARTER_HOUR;
  return [quarterHourGrain(env, grain.bucket, since, openFrom), quarterHourTail(env, openFrom)];
}

export async function readBuckets(
  env: Env,
  range: Range,
  now: number,
  projects: readonly Project[],
): Promise<Map<string, Bucket[]>> {
  const grain = GRAIN[range];
  // Where the window starts is not where the first bucket does. A rolled-up row
  // is stamped with the start of its bucket, so asking for everything at or
  // after `now - a day` throws away the bucket that `now - a day` falls inside —
  // a whole quarter hour of checks, and the leftmost bar of every window drawn
  // as though nothing had been measured in it. The grid begins at the bucket
  // boundary, and so does the question.
  const first = Math.floor((now - grain.span) / grain.bucket) * grain.bucket;
  const answers = await env.DB.batch<Record<string, number | string>>(readersFor(env, grain, first, now));
  const measured = new Map<string, Map<number, Bucket>>();
  for (const answer of answers) {
    for (const row of answer.results) {
      const id = String(row.project_id);
      const at = Number(row.bucket_at);
      const found = measured.get(id) ?? new Map<number, Bucket>();
      found.set(at, { at, checks: Number(row.checks), failures: Number(row.failures), p50_ms: Number(row.p50_ms) });
      measured.set(id, found);
    }
  }

  // The window is handed over whole, not only the part that has rows. A
  // project watched since yesterday still answers with ninety days of buckets,
  // the earlier ones empty: the strip then holds the same number of bars in
  // every window, and a stretch nobody has data for is drawn as such rather
  // than squeezing the rest of the history across the whole card. Buckets are
  // laid on the same grid the queries group by, so a measured one lands in its
  // own slot.
  const last = Math.floor(now / grain.bucket) * grain.bucket;
  const count = Math.round((last - first) / grain.bucket) + 1;
  const byProject = new Map<string, Bucket[]>();
  for (const project of projects) {
    const found = measured.get(project.id);
    byProject.set(project.id, Array.from({ length: count }, (_unused, index) => {
      const at = first + index * grain.bucket;
      return found?.get(at) ?? { at, checks: 0, failures: 0, p50_ms: 0 };
    }));
  }
  return byProject;
}

export type Latest = { state: ProjectState; ms: number | null; detail: string | null; at: number | null };

/**
 * A project is down once it has failed `failuresBeforeDown` checks in a row.
 * One bad minute from one probe location is noise, and a status page that
 * reports noise stops being read.
 *
 * One indexed lookup per project, never a pass over the table. The window
 * function this replaced numbered every row in `checks` before the outer
 * filter could drop one, so each probe and each page view read the whole
 * retention — and D1 bills rows read, so two projects at a check a minute
 * spent the daily allowance several times over. `checks_project_at` answers
 * each of these from the newest rows of one project, so the cost follows the
 * window asked for rather than the history kept.
 *
 * The projects are the configured ones rather than whatever ids the table
 * holds: an id dropped from the catalogue should stop being reported, not go
 * on raising alerts from its last rows until the retention forgets it.
 */
export async function readLatest(
  env: Env,
  config: Settings,
  projects: readonly Project[],
): Promise<Map<string, Latest>> {
  if (projects.length === 0) return new Map();
  const window = Math.max(config.failuresBeforeDown, 1);
  const statement = env.DB.prepare(
    "SELECT at, ok, ms, detail FROM checks WHERE project_id = ? ORDER BY at DESC LIMIT ?",
  );
  const answers = await env.DB.batch<Record<string, number | string | null>>(
    projects.map((project) => statement.bind(project.id, window)),
  );

  const byProject = new Map<string, Latest>();
  projects.forEach((project, index) => {
    const checks = answers[index]?.results ?? [];
    const newest = checks[0];
    if (newest === undefined) return;
    const failing = checks.length >= window && checks.every((check) => check.ok === 0);
    byProject.set(project.id, {
      state: failing ? "down" : "up",
      ms: Number(newest.ms),
      detail: failing && newest.detail !== null ? String(newest.detail) : null,
      at: Number(newest.at),
    });
  });
  return byProject;
}

export type Announcement = { projectId: string; from: ProjectState; to: ProjectState; detail: string | null };

/** Compares what is true with what was last announced, and records the change. */
export async function claimTransitions(env: Env, latest: Map<string, Latest>, now: number): Promise<Announcement[]> {
  const stored = await env.DB.prepare("SELECT project_id, state FROM announced").all<{ project_id: string; state: string }>();
  const previous = new Map(stored.results.map((row) => [row.project_id, row.state as ProjectState]));

  const changes: Announcement[] = [];
  const writes = [];
  for (const [projectId, state] of latest) {
    if (state.state === "unknown") continue;
    const before = previous.get(projectId) ?? "unknown";
    if (before === state.state) continue;
    changes.push({ projectId, from: before, to: state.state, detail: state.detail });
    writes.push(env.DB.prepare(`
      INSERT INTO announced (project_id, state, since, detail) VALUES (?, ?, ?, ?)
      ON CONFLICT (project_id) DO UPDATE SET state = excluded.state, since = excluded.since, detail = excluded.detail
    `).bind(projectId, state.state, now, state.detail));
  }
  if (writes.length > 0) await env.DB.batch(writes);
  return changes;
}
