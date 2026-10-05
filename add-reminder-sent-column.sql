-- add-reminder-sent-column.sql
-- REQUIRED before using the resumable reminder sender (send-reminder.js).
-- Run in the Supabase SQL editor. Safe to run more than once.
--
-- send-reminder.js stamps reminder_sent_at after each email, and only picks up
-- Paid registrants where it is still NULL, so a restart never double-sends.

-- 1) Column
ALTER TABLE registrations
  ADD COLUMN IF NOT EXISTS reminder_sent_at timestamptz;

-- 2) Index for the "next batch" query (Paid + not yet emailed)
CREATE INDEX IF NOT EXISTS idx_registrations_reminder_pending
  ON registrations (payment_status, reminder_sent_at);


-- ---------------------------------------------------------------------------
-- Progress check (read-only): how many Paid registrants have been emailed
-- ---------------------------------------------------------------------------
-- SELECT
--   COUNT(*) FILTER (WHERE reminder_sent_at IS NOT NULL) AS sent,
--   COUNT(*) FILTER (WHERE reminder_sent_at IS NULL)     AS remaining,
--   COUNT(*)                                             AS total_paid
-- FROM registrations
-- WHERE payment_status = 'Paid';


-- ---------------------------------------------------------------------------
-- Reset ALL (only to send the reminder again to everyone, e.g. a new reminder)
-- Uncomment and run deliberately — this makes every Paid registrant eligible again.
-- ---------------------------------------------------------------------------
-- UPDATE registrations SET reminder_sent_at = NULL WHERE reminder_sent_at IS NOT NULL;
