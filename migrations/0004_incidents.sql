-- What the probes cannot say. The strip records that a service stopped
-- answering; an incident records what is being done about it, which is the
-- difference between a monitoring dashboard and a status page.
--
-- Two states, deliberately, because they answer to different authorities. The
-- machine owns whether the service answers: it opens an incident when a project
-- is called down and stamps `ended_at` when the checks pass again, and neither
-- is a person's to edit. A person owns `handling` — what is being done — and
-- the cause, which no probe can know.
--
-- `touched` is how the two stay out of each other's way. An incident nobody
-- wrote in is the machine's alone and closes itself the moment the checks
-- recover, which is what should happen to a blip at four in the morning. Once
-- somebody has written in it, recovery no longer closes it: the page keeps
-- saying so until the person who is on it says otherwise.
CREATE TABLE IF NOT EXISTS incidents (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT    NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at   INTEGER,
  handling   TEXT    NOT NULL DEFAULT 'investigating',
  cause      TEXT,
  touched    INTEGER NOT NULL DEFAULT 0
);

-- One open incident per project is the invariant the probe relies on; this is
-- what lets it ask for it without reading the table.
CREATE UNIQUE INDEX IF NOT EXISTS incidents_open ON incidents (project_id) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS incidents_started ON incidents (started_at DESC);

-- Every word a person wrote, kept in order. The page shows the latest and the
-- history underneath, because "we found it" reads differently when you can see
-- it was written twenty minutes after "we are looking".
CREATE TABLE IF NOT EXISTS incident_updates (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  incident_id INTEGER NOT NULL REFERENCES incidents (id),
  at          INTEGER NOT NULL,
  handling    TEXT,
  cause       TEXT,
  body        TEXT    NOT NULL,
  author      TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS incident_updates_incident ON incident_updates (incident_id, at);
