-- Who opened an incident, because it decides what resolving one means.
--
-- `ended_at` records that the checks recovered, and only the probe can know
-- that. An incident a person opens may sit on a service that never stopped
-- answering, so nothing will ever stamp it; resolved with no end, it would
-- stay on the page for ever. Knowing who opened it lets resolving end the ones
-- no recovery is ever coming for, and leave the others exactly as they were.
ALTER TABLE incidents ADD COLUMN opened_by TEXT NOT NULL DEFAULT 'probe';
