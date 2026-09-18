-- Raw probes. Kept for a week, then folded into `daily` and deleted.
CREATE TABLE IF NOT EXISTS checks (
  project_id TEXT NOT NULL,
  at         INTEGER NOT NULL,
  ok         INTEGER NOT NULL,
  ms         INTEGER NOT NULL,
  detail     TEXT
);

CREATE INDEX IF NOT EXISTS checks_project_at ON checks (project_id, at DESC);
CREATE INDEX IF NOT EXISTS checks_at ON checks (at);

-- One row per project per day, kept forever. This is what the page reads.
CREATE TABLE IF NOT EXISTS daily (
  project_id TEXT NOT NULL,
  day        TEXT NOT NULL,
  checks     INTEGER NOT NULL,
  failures   INTEGER NOT NULL,
  p50_ms     INTEGER NOT NULL,
  p95_ms     INTEGER NOT NULL,
  PRIMARY KEY (project_id, day)
);
