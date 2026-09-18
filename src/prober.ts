import { DurableObject } from "cloudflare:workers";

import { runCheck } from "./checks";
import type { Check, CheckOutcome } from "./types";

/**
 * One place to measure from.
 *
 * A Worker on a cron trigger runs wherever Cloudflare has spare capacity, and
 * that decides most of what the stopwatch reads: the distance to the service,
 * and — when the service sits behind a CDN, as ours does — whether the edge
 * that answers has the thing cached. The same service measured from three
 * machines on three days gives three numbers, and the chart draws the change of
 * machine as though it were a change in the service. It did exactly that on
 * 18 September, stepping between roughly 110, 400 and 1000 ms without anything
 * having happened to anybody's site.
 *
 * A Durable Object does not move once it exists, so asking it to do the
 * fetching makes every reading comparable with the one before it. What is lost
 * is breadth: this is now the latency from one place rather than a sample of
 * the world. That is the right trade for a line whose job is to show a change
 * over time, and the page says where it measures from.
 *
 * Availability does not depend on any of this. It is decided by whether the
 * service answered at all, and the fallback in the Worker probes directly if
 * this object cannot be reached, so a problem here costs accuracy and never
 * the check itself.
 */
export class Prober extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    const asked = await request.json().catch(() => null) as {
      checks?: Check[];
      timeoutMs?: number;
      attempts?: number;
    } | null;
    if (asked?.checks === undefined) return new Response("nothing to check", { status: 400 });

    const timeoutMs = asked.timeoutMs ?? 8000;
    const attempts = asked.attempts ?? 2;

    // Every probe settles: one unreachable service must not cost the others
    // their tick.
    const outcomes = await Promise.all(asked.checks.map(async (check): Promise<CheckOutcome> => {
      let outcome = await runCheck(check, timeoutMs);
      for (let attempt = 1; attempt < attempts && !outcome.ok; attempt += 1) {
        outcome = await runCheck(check, timeoutMs);
      }
      return outcome;
    }));

    return Response.json({ outcomes });
  }
}
