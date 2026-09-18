import type { Check, CheckOutcome, HttpCheck } from "../types";

export async function fetchWithTiming(url: string, timeoutMs: number): Promise<{ response: Response; ms: number }> {
  // What the page prints is the service's answer, so that is what gets timed —
  // the request, not the invocation that made it. A Worker's clock only moves
  // when its I/O does, so a reading taken straight away can still be the
  // moment the isolate was handed the job: cold start and module evaluation
  // would be billed to the service, and a probe running a second would report
  // a site that answers in fifty milliseconds as a site that answers in one.
  // Yielding is an I/O boundary, so the reading after it is now.
  await scheduler.wait(0);
  const started = Date.now();
  const response = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    redirect: "follow",
    headers: { "user-agent": "status.drarzter.dev probe" },
    // The probe must see the origin, not a cached answer from the edge.
    cf: { cacheTtl: 0, cacheEverything: false },
  });
  return { response, ms: Date.now() - started };
}

export async function httpCheck(check: Check, fallbackTimeoutMs: number): Promise<CheckOutcome> {
  const { url, expect = 200, timeoutMs } = check as HttpCheck;
  const { response, ms } = await fetchWithTiming(url, timeoutMs ?? fallbackTimeoutMs);
  if (response.status !== expect) return { ok: false, ms, detail: `HTTP ${response.status}, expected ${expect}` };
  return { ok: true, ms };
}
