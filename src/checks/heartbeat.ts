import type { Check, CheckOutcome, HeartbeatCheck } from "../types";
import { fetchWithTiming } from "./http";
import { readPath } from "./json";

function asEpochMs(value: unknown): number | null {
  if (typeof value === "number") return value > 1e12 ? value : value * 1000;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

// Health for something that is meant to be idle between runs: the question is
// not "is it answering now" but "did it run recently enough".
export async function heartbeatCheck(check: Check, fallbackTimeoutMs: number): Promise<CheckOutcome> {
  const { url, path, withinMinutes, timeoutMs } = check as HeartbeatCheck;
  const { response, ms } = await fetchWithTiming(url, timeoutMs ?? fallbackTimeoutMs);
  if (!response.ok) return { ok: false, ms, detail: `HTTP ${response.status}` };
  const last = asEpochMs(readPath(await response.json(), path));
  if (last === null) return { ok: false, ms, detail: `${path} is not a timestamp` };
  const ageMinutes = Math.round((Date.now() - last) / 60000);
  if (ageMinutes > withinMinutes) return { ok: false, ms, detail: `Last run ${ageMinutes} min ago, expected within ${withinMinutes}` };
  return { ok: true, ms };
}
