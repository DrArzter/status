import catalogue from "../config/projects.json";
import { runCheck } from "./checks";
import { Prober } from "./prober";
import { settings, type Settings } from "./config";
import { announce } from "./notify";
import { identify } from "./access";
import { openIncident, readIncidents, readOpenRequest, readUpdateRequest, trackIncidents, writeUpdate } from "./incidents";
import { catchUp, claimTransitions, foldNow, GRAIN, readBuckets, readLatest, rollUp, writeResults, type Written } from "./store";
import type { CheckOutcome, Env, Project, Range } from "./types";

const projects = catalogue.projects as Project[];
const RANGES: Range[] = ["day", "week", "month", "quarter", "year"];
const ROLLUP_CRON = "0 3 * * *";
const CATCH_UP_CRON = "7 * * * *";
// One probe's worth. Nothing this answers with changes faster than the cron
// writes it, so half of this bought no freshness and twice the reads: at a
// check a minute and a page that asks once a minute, a thirty-second entry was
// recomputed every time to say what it had already said.
const STATUS_MAX_AGE = 60;

/** Where the measuring happens, and what to do when it cannot. */
const PINNED: DurableObjectLocationHint = "weur";

/**
 * Asks the pinned object to run this tick's checks, so every reading comes from
 * the same place as the one before it. Attempts inside the tick absorb a single
 * blip; a real outage still takes `failuresBeforeDown` ticks to be called down.
 *
 * If the object cannot be reached the checks run here instead. A tick measured
 * from the wrong place is worth far more than a tick with no answer at all: the
 * page would otherwise show a gap, and a gap on a status page reads as an
 * outage that never happened.
 */
async function measure(env: Env, config: Settings): Promise<Written[]> {
  const asked = JSON.stringify({
    checks: projects.map((project) => project.check),
    timeoutMs: config.timeoutMs,
    attempts: config.attempts,
  });

  try {
    const prober = env.PROBER.get(env.PROBER.idFromName(PINNED), { locationHint: PINNED });
    const answer = await prober.fetch("https://prober/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: asked,
    });
    if (!answer.ok) throw new Error(`prober answered ${answer.status}`);
    const { outcomes } = await answer.json() as { outcomes: CheckOutcome[] };
    if (outcomes.length !== projects.length) throw new Error("prober answered about the wrong number of checks");
    return projects.map((project, index) => ({ project, outcome: outcomes[index]! }));
  } catch (error) {
    console.error("prober unreachable, measuring from this tick's own location", error);
    return Promise.all(projects.map(async (project): Promise<Written> => {
      let outcome = await runCheck(project.check, config.timeoutMs);
      for (let attempt = 1; attempt < config.attempts && !outcome.ok; attempt += 1) {
        outcome = await runCheck(project.check, config.timeoutMs);
      }
      return { project, outcome };
    }));
  }
}

async function probeAll(env: Env): Promise<void> {
  const config = settings(env);
  const at = Date.now();

  const outcomes = await measure(env, config);
  await writeResults(env, at, outcomes);
  // What was just written, folded into the grain the day window reads. It has
  // to happen here rather than on the hour: that window is the one people watch
  // to see what is happening now.
  await foldNow(env, at);

  const latest = await readLatest(env, config, projects);
  const changes = await claimTransitions(env, latest, at);
  // The incident is opened before anybody is told, so the page and the alert
  // agree from the first second rather than a tick apart.
  await trackIncidents(env, changes, at);
  await announce(env, changes, projects);
}

async function status(env: Env, range: Range, origin: string, ctx: ExecutionContext): Promise<Response> {
  // One reader's poll answers every reader's poll for the next half minute. A
  // Worker's response is never cached unless it is put there by hand, and each
  // open tab asks once a minute, so without this every tab is its own pass over
  // the database — which is what a day range costs most.
  //
  // The key is a path nothing can request. Keyed by the real URL, the entry is
  // one Cloudflare can serve before this Worker runs, and it then rewrites the
  // answer's `cache-control` to the zone's browser TTL — four hours here — so a
  // page that trusts the header sat on an hour-old reading and looked stopped.
  // Under a key of its own the answer is only ever handed out by the code
  // below, with the half minute it actually means.
  const key = new Request(`${origin}/__status-cache/${range}`);
  const cached = await caches.default.match(key);
  if (cached) return cached;

  const config = settings(env);
  const now = Date.now();
  const [latest, buckets, incidents] = await Promise.all([
    readLatest(env, config, projects),
    readBuckets(env, range, now, projects),
    readIncidents(env, now),
  ]);

  const response = Response.json({
    generatedAt: now,
    range,
    ranges: RANGES,
    // How much time one bar covers, so the page can say so rather than leaving
    // the reader to infer it from the axis.
    bucketMs: GRAIN[range].bucket,
    // What the probes cannot say. Named by project, so the page can put an
    // incident beside the service it belongs to.
    incidents: incidents.map((incident) => ({
      ...incident,
      name: projects.find((project) => project.id === incident.projectId)?.name ?? incident.projectId,
    })),
    projects: projects.map((project) => {
      const found = latest.get(project.id);
      return {
        id: project.id,
        name: project.name,
        group: project.group ?? null,
        note: project.note ?? null,
        link: project.link ?? null,
        state: found?.state ?? "unknown",
        ms: found?.ms ?? null,
        detail: found?.detail ?? null,
        checkedAt: found?.at ?? null,
        buckets: buckets.get(project.id) ?? [],
      };
    }),
  }, {
    headers: { "cache-control": `public, max-age=${STATUS_MAX_AGE}` },
  });

  ctx.waitUntil(caches.default.put(key, response.clone()));
  return response;
}

/**
 * The one route that writes. Everything under `/admin` is behind Cloudflare
 * Access, and this checks the token it forwards as well: the page is guarded by
 * hostname and path, and a Worker outlives the hostnames it was configured for.
 */
async function update(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
  const identity = await identify(request, env);
  if (identity === null) return new Response("not signed in", { status: 403 });

  const asked = readUpdateRequest(await request.json().catch(() => null));
  if (asked === null) return new Response("unreadable update", { status: 400 });
  const incidentId = Number(new URL(request.url).searchParams.get("incident"));
  if (!Number.isInteger(incidentId)) return new Response("no incident named", { status: 400 });

  const written = await writeUpdate(env, incidentId, { ...asked, author: identity.email }, Date.now());
  return written
    ? Response.json({ written: true })
    : new Response("nothing to write, or no such incident", { status: 400 });
}

/**
 * Whether whoever is asking may write, so the public page can offer the way in
 * to the one person it is useful to and to nobody else.
 *
 * It answers under `/admin`, which is the point: Access guards that path, so a
 * signed-in browser reaches this with a token and anybody else is sent to the
 * sign-in page before the Worker is ever asked. A reader's page therefore gets
 * a redirect it cannot read, which is the same answer as no.
 */
async function whoami(request: Request, env: Env): Promise<Response> {
  const identity = await identify(request, env);
  return identity === null
    ? new Response("not signed in", { status: 403 })
    : Response.json({ email: identity.email }, { headers: { "cache-control": "no-store" } });
}

/**
 * An incident opened by a person, for what no probe can see. The project has to
 * be one we actually watch: the page offers a list, but the page is not what
 * arrives here.
 */
async function open(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
  const identity = await identify(request, env);
  if (identity === null) return new Response("not signed in", { status: 403 });

  const asked = readOpenRequest(await request.json().catch(() => null));
  if (asked === null) return new Response("unreadable incident", { status: 400 });
  if (!catalogue.projects.some((project) => project.id === asked.projectId)) {
    return new Response("no such project", { status: 400 });
  }

  const id = await openIncident(env, { ...asked, author: identity.email }, Date.now());
  return id === null
    ? new Response("nothing to write", { status: 400 })
    : Response.json({ opened: id });
}

export default {
  async scheduled(event: ScheduledController, env: Env): Promise<void> {
    if (event.cron === ROLLUP_CRON) await rollUp(env, Date.now(), settings(env));
    else if (event.cron === CATCH_UP_CRON) await catchUp(env, Date.now());
    else await probeAll(env);
  },

  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/status") {
      const asked = url.searchParams.get("range") as Range | null;
      return status(env, asked && RANGES.includes(asked) ? asked : "day", url.origin, ctx);
    }
    if (url.pathname === "/admin/api/updates") return update(request, env);
    if (url.pathname === "/admin/api/incidents") return open(request, env);
    if (url.pathname === "/admin/api/whoami") return whoami(request, env);
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;

export { Prober };
