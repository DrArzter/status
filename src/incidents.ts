import type { Announcement } from "./store";
import type { Env } from "./types";

/** What is being done about it. The machine only ever writes the first and last. */
export const HANDLING = ["investigating", "identified", "monitoring", "resolved"] as const;
export type Handling = (typeof HANDLING)[number];

/** Who or what is at fault, as far as anyone knows. No probe can tell. */
export const CAUSES = ["cloudflare", "aws", "upstream", "us", "unknown"] as const;
export type Cause = (typeof CAUSES)[number];

export type IncidentUpdate = {
  at: number;
  handling: Handling | null;
  cause: Cause | null;
  body: string;
  author: string;
};

export type Incident = {
  id: number;
  projectId: string;
  startedAt: number;
  endedAt: number | null;
  handling: Handling;
  cause: Cause | null;
  updates: IncidentUpdate[];
};

const isHandling = (value: unknown): value is Handling => HANDLING.includes(value as Handling);
const isCause = (value: unknown): value is Cause => CAUSES.includes(value as Cause);

/**
 * Opens and closes incidents from what the probe just decided.
 *
 * A project called down opens one, and a project back up stamps the end. The
 * open index makes the first idempotent: a second attempt while one is open
 * does nothing, so a transition seen twice cannot leave two.
 *
 * Recovery closes the handling as well, but only for an incident nobody has
 * written in. Once somebody has, the page goes on saying what they said until
 * they say otherwise — a service that answers again is not the same thing as a
 * problem understood.
 */
export async function trackIncidents(env: Env, changes: readonly Announcement[], now: number): Promise<void> {
  const writes = changes.flatMap((change) => {
    if (change.to === "down") {
      return [env.DB.prepare(`
        INSERT INTO incidents (project_id, started_at, handling) VALUES (?, ?, 'investigating')
        ON CONFLICT (project_id) WHERE ended_at IS NULL DO NOTHING
      `).bind(change.projectId, now)];
    }
    if (change.to === "up") {
      return [env.DB.prepare(`
        UPDATE incidents
           SET ended_at = ?, handling = CASE WHEN touched = 0 THEN 'resolved' ELSE handling END
         WHERE project_id = ? AND ended_at IS NULL
      `).bind(now, change.projectId)];
    }
    return [];
  });
  if (writes.length > 0) await env.DB.batch(writes);
}

/**
 * What the page shows: everything still open, and everything closed recently
 * enough to be worth reading. An incident is open while it is unresolved, which
 * is not the same as while the service is down — a recovered outage somebody is
 * still writing about stays up, and that is the point of having two states.
 */
export async function readIncidents(env: Env, now: number, keepClosedFor = 86_400_000): Promise<Incident[]> {
  const [open, updates] = await env.DB.batch<Record<string, number | string | null>>([
    env.DB.prepare(`
      SELECT id, project_id, started_at, ended_at, handling, cause FROM incidents
       WHERE handling != 'resolved' OR ended_at IS NULL OR ended_at >= ?
       ORDER BY started_at DESC LIMIT 20
    `).bind(now - keepClosedFor),
    env.DB.prepare(`
      SELECT incident_id, at, handling, cause, body, author FROM incident_updates
       WHERE incident_id IN (
         SELECT id FROM incidents
          WHERE handling != 'resolved' OR ended_at IS NULL OR ended_at >= ?
          ORDER BY started_at DESC LIMIT 20
       )
       ORDER BY at
    `).bind(now - keepClosedFor),
  ]);

  const byIncident = new Map<number, IncidentUpdate[]>();
  for (const row of updates?.results ?? []) {
    const id = Number(row.incident_id);
    const list = byIncident.get(id) ?? [];
    list.push({
      at: Number(row.at),
      handling: isHandling(row.handling) ? row.handling : null,
      cause: isCause(row.cause) ? row.cause : null,
      body: String(row.body),
      author: String(row.author),
    });
    byIncident.set(id, list);
  }

  return (open?.results ?? []).map((row) => ({
    id: Number(row.id),
    projectId: String(row.project_id),
    startedAt: Number(row.started_at),
    endedAt: row.ended_at === null ? null : Number(row.ended_at),
    handling: isHandling(row.handling) ? row.handling : "investigating",
    cause: isCause(row.cause) ? row.cause : null,
    updates: byIncident.get(Number(row.id)) ?? [],
  }));
}

export type Written = { handling?: Handling; cause?: Cause; body: string; author: string };

/**
 * A person's word on an open incident. Writing marks it touched, which is what
 * stops a recovery from closing it out from under them; the handling and the
 * cause carry over to the incident so the page can state them without reading
 * the whole history.
 *
 * Resolving is the one thing that can close an incident the probes still call
 * down. That is deliberate: "known and being lived with" is a real answer, and
 * refusing it would mean the only way to clear the banner is to fix the service.
 */
export async function writeUpdate(env: Env, incidentId: number, update: Written, now: number): Promise<boolean> {
  const body = update.body.trim();
  if (body.length === 0 || body.length > 2000) return false;

  const incident = await env.DB.prepare("SELECT id FROM incidents WHERE id = ?").bind(incidentId).first<{ id: number }>();
  if (incident === null) return false;

  await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO incident_updates (incident_id, at, handling, cause, body, author)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(incidentId, now, update.handling ?? null, update.cause ?? null, body, update.author),
    env.DB.prepare(`
      UPDATE incidents
         SET touched = 1,
             handling = coalesce(?, handling),
             cause = coalesce(?, cause)
       WHERE id = ?
    `).bind(update.handling ?? null, update.cause ?? null, incidentId),
  ]);
  return true;
}

/** Parses what the admin page posted, refusing anything it does not recognise. */
export function readUpdateRequest(input: unknown): Written | null {
  if (typeof input !== "object" || input === null) return null;
  const { handling, cause, body } = input as Record<string, unknown>;
  if (typeof body !== "string") return null;
  if (handling !== undefined && !isHandling(handling)) return null;
  if (cause !== undefined && !isCause(cause)) return null;
  return {
    body,
    author: "",
    ...(isHandling(handling) ? { handling } : {}),
    ...(isCause(cause) ? { cause } : {}),
  };
}
