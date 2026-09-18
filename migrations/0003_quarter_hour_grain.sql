-- A fourth grain, and the only one no window is named after: quarter hours
-- exist so the day window has something to read that is not the raw table.
-- Grouping a day of per-minute checks read about nine thousand rows an answer,
-- which is the whole daily allowance in ten minutes of somebody watching; the
-- same answer from here is a couple of hundred.
--
-- Folded after every probe rather than on the hour, because this is what the
-- day window shows and that window is read to see what is happening now.
CREATE TABLE IF NOT EXISTS quarter_hourly (
  project_id TEXT NOT NULL,
  at         INTEGER NOT NULL,
  checks     INTEGER NOT NULL,
  failures   INTEGER NOT NULL,
  p50_ms     INTEGER NOT NULL,
  p95_ms     INTEGER NOT NULL,
  PRIMARY KEY (project_id, at)
);

CREATE INDEX IF NOT EXISTS quarter_hourly_at ON quarter_hourly (at);

-- Fill it from the raw rows that already exist, so the day window has its
-- history the moment this lands rather than a blank strip until the first
-- fold. Raw retention is a couple of days, so this reads a few thousand rows
-- once. `DO NOTHING` because a re-run must not undo a fold that came after.
INSERT INTO quarter_hourly (project_id, at, checks, failures, p50_ms, p95_ms)
SELECT project_id, (at / 900000) * 900000 AS bucket_at, count(*), sum(1 - ok),
       cast(avg(ms) AS int), cast(max(ms) AS int)
  FROM checks GROUP BY project_id, bucket_at
ON CONFLICT (project_id, at) DO NOTHING;
