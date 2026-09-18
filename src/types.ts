export type HttpCheck = {
  type: "http";
  url: string;
  expect?: number;
  timeoutMs?: number;
};

export type JsonCheck = {
  type: "json";
  url: string;
  /** Dotted path into the response body, for example "status" or "data.state". */
  path: string;
  equals: string | number | boolean;
  timeoutMs?: number;
};

/** For anything that is off by design between runs: a cron, a batch job, a game host. */
export type HeartbeatCheck = {
  type: "heartbeat";
  url: string;
  /** Dotted path to an ISO timestamp or epoch seconds. */
  path: string;
  withinMinutes: number;
  timeoutMs?: number;
};

export type Check = HttpCheck | JsonCheck | HeartbeatCheck;

export type Project = {
  id: string;
  name: string;
  group?: string;
  note?: string;
  /** Where the name goes: the project's own site, or its repository. */
  link?: { href: string; label: string };
  check: Check;
};

export type CheckOutcome = {
  ok: boolean;
  /**
   * Round trip from the probe, in milliseconds: one Cloudflare location to the
   * service and back. Not what a player somewhere else sees, and not a figure
   * to compare against one.
   */
  ms: number;
  /** One short line, shown only when something is wrong. */
  detail?: string;
};

export type ProjectState = "up" | "down" | "unknown";

/** The windows the bar can be read at, coarsest grain chosen per window. */
export type Range = "day" | "week" | "month" | "quarter" | "year";

export type Bucket = {
  /** Start of the bucket, epoch milliseconds. */
  at: number;
  checks: number;
  failures: number;
  p50_ms: number;
};

export type Env = {
  DB: D1Database;
  ASSETS: Fetcher;

  // Tunables, supplied by the deploy from GitHub repository variables.
  PROBE_ATTEMPTS?: string;
  FAILURES_BEFORE_DOWN?: string;
  PROBE_TIMEOUT_MS?: string;
  RAW_RETENTION_DAYS?: string;
  HOURLY_RETENTION_DAYS?: string;

  // Cloudflare Access, which guards the one page that can write. Absent, the
  // admin surface refuses everybody rather than letting everybody in: a
  // half-configured door is the one failure mode worth being certain about.
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;

  // Alert channels. A channel exists only when its secrets are present, so
  // adding one is a secret and never a code change.
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  RESEND_API_KEY?: string;
  ALERT_EMAIL_TO?: string;
  ALERT_EMAIL_FROM?: string;
  ALERT_WEBHOOK_URL?: string;
};
