-- Three grains, because one cannot answer both "the last day" and "the last
-- nine months". Raw rows are minutes and live briefly; hours cover weeks;
-- days are kept for good and cost nothing.
CREATE TABLE IF NOT EXISTS hourly (
  project_id TEXT NOT NULL,
  hour       INTEGER NOT NULL,
  checks     INTEGER NOT NULL,
  failures   INTEGER NOT NULL,
  p50_ms     INTEGER NOT NULL,
  p95_ms     INTEGER NOT NULL,
  PRIMARY KEY (project_id, hour)
);

CREATE INDEX IF NOT EXISTS hourly_hour ON hourly (hour);

-- What was last announced, so an alert fires on a change and not on every
-- failed check. Nothing here is user data; it is one row per project.
CREATE TABLE IF NOT EXISTS announced (
  project_id TEXT PRIMARY KEY,
  state      TEXT NOT NULL,
  since      INTEGER NOT NULL,
  detail     TEXT
);
