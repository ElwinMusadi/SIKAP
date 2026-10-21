-- Phase 5 review: outbox claim/lease + retry scheduling.
--
-- flushOutbox() runs from several places at once (waitUntil after a mutation, the cron,
-- overlapping cron ticks). A row is now CLAIMED atomically before it is sent:
--   UPDATE … SET lease_token = <random per flush>, lease_until = now + 60 s
--    WHERE id IN (SELECT … due AND (lease_until IS NULL OR lease_until <= now) LIMIT n)
--      AND status = 'PENDING' AND attempts < 5
--   RETURNING …
-- Only the holder of the token may finish the row (WHERE id = ? AND lease_token = ?), and
-- finishing clears the lease. A crashed/evicted flush leaves a lease that simply expires.
--
-- next_attempt_at: earliest time a PENDING row may be (re)tried. NULL = due now (rows
-- written before this migration, and fresh rows from outboxStatements()). Set on failure
-- (backoff) and when the provider is not configured (no attempt is consumed then).
--
-- Delivery semantics are AT-LEAST-ONCE: if the provider accepted a message but the
-- worker died before the SENT update committed, the lease expires and the row is sent again.
--
-- Additive and nullable; existing rows need no backfill.

ALTER TABLE notifikasi_outbox ADD COLUMN lease_token TEXT;
ALTER TABLE notifikasi_outbox ADD COLUMN lease_until TEXT;
ALTER TABLE notifikasi_outbox ADD COLUMN next_attempt_at TEXT;

-- Claim scan: only PENDING rows, in send order, with the filter columns in the index so
-- the due/lease predicates are evaluated without touching the table.
DROP INDEX IF EXISTS idx_outbox_pending;
CREATE INDEX idx_outbox_pending_due
  ON notifikasi_outbox(created_at, id, attempts, next_attempt_at, lease_until)
  WHERE status = 'PENDING';
