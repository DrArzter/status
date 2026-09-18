import type { Check, CheckOutcome } from "../types";
import { httpCheck } from "./http";
import { jsonCheck } from "./json";
import { heartbeatCheck } from "./heartbeat";

type Probe<C extends Check> = (check: C, timeoutMs: number) => Promise<CheckOutcome>;

// Adding a check type is a module and a line here. Adding a project is a line
// in config/projects.json and no code at all.
const probes = {
  http: httpCheck as Probe<Check>,
  json: jsonCheck as Probe<Check>,
  heartbeat: heartbeatCheck as Probe<Check>,
} satisfies Record<Check["type"], Probe<Check>>;

export async function runCheck(check: Check, timeoutMs: number): Promise<CheckOutcome> {
  const probe = probes[check.type];
  if (!probe) return { ok: false, ms: 0, detail: `Unknown check type: ${check.type}` };
  const started = Date.now();
  try {
    return await probe(check, timeoutMs);
  } catch (error) {
    // A thrown probe is a failed check, never a failed tick: one bad project
    // must not take the others down with it.
    return { ok: false, ms: Date.now() - started, detail: message(error) };
  }
}

export function message(error: unknown): string {
  if (error instanceof Error) return error.name === "TimeoutError" ? "Timed out" : error.message.slice(0, 200);
  return String(error).slice(0, 200);
}
