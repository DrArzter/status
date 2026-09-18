import type { Env } from "./types";

// Everything tunable arrives as a Worker variable, which the deploy fills from
// GitHub repository variables. Defaults are the values worth shipping, so an
// unset variable is never a broken deployment.
export type Settings = {
  /** Attempts inside one tick before a check counts as failed. */
  attempts: number;
  /** Consecutive failed checks before a project is called down. */
  failuresBeforeDown: number;
  timeoutMs: number;
  rawRetentionDays: number;
  hourlyRetentionDays: number;
};

const number = (value: string | undefined, fallback: number, min: number, max: number): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), min), max);
};

export function settings(env: Env): Settings {
  return {
    attempts: number(env.PROBE_ATTEMPTS, 2, 1, 5),
    failuresBeforeDown: number(env.FAILURES_BEFORE_DOWN, 3, 1, 20),
    timeoutMs: number(env.PROBE_TIMEOUT_MS, 8000, 1000, 20000),
    rawRetentionDays: number(env.RAW_RETENTION_DAYS, 2, 1, 14),
    hourlyRetentionDays: number(env.HOURLY_RETENTION_DAYS, 90, 7, 400),
  };
}
