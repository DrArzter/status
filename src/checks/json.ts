import type { Check, CheckOutcome, JsonCheck } from "../types";
import { fetchWithTiming } from "./http";

export function readPath(body: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((value, key) => {
    if (value === null || typeof value !== "object") return undefined;
    return (value as Record<string, unknown>)[key];
  }, body);
}

export async function jsonCheck(check: Check, fallbackTimeoutMs: number): Promise<CheckOutcome> {
  const { url, path, equals, timeoutMs } = check as JsonCheck;
  const { response, ms } = await fetchWithTiming(url, timeoutMs ?? fallbackTimeoutMs);
  if (!response.ok) return { ok: false, ms, detail: `HTTP ${response.status}` };
  // A page where an API was expected is the common answer, and a parser's
  // complaint about "<!doctype" is not something to show on a status page.
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, ms, detail: "The response was not JSON" };
  }
  const actual = readPath(body, path);
  if (actual !== equals) return { ok: false, ms, detail: `${path} is ${JSON.stringify(actual)}, expected ${JSON.stringify(equals)}` };
  return { ok: true, ms };
}
