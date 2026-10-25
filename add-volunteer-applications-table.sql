-- add-volunteer-applications-table.sql
-- REQUIRED before the volunteer sign-up page (/volunteer) can save sign-ups.
-- Run once in the Supabase SQL editor. Safe to run more than once.

CREATE TABLE IF NOT EXISTS volunteer_applications (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  first_name       text NOT NULL,
  last_name        text NOT NULL,
  age              text NOT NULL,          -- '14-17' | '18-25' | '26-35' | '36+'
  gender           text NOT NULL,          -- 'Male' | 'Female'
  email            text NOT NULL,
  phone            text NOT NULL,
  location_type    text NOT NULL,          -- 'philippines' | 'international'
  region           text,
  city             text,
  country          text,
  home_church      text NOT NULL,
  pyc_number       text,                   -- PYC-0487 format, if already registered
  roles            text[] NOT NULL,        -- e.g. {media,prayer}
  availability     text[] NOT NULL,        -- e.g. {jun1,jun2,jun5}
  experience       text,
  motivation       text,
  guardian_consent boolean NOT NULL DEFAULT false,
  status           text NOT NULL DEFAULT 'New',   -- New | Contacted | Assigned | Declined
  assigned_team    text,
  notes            text
);

CREATE UNIQUE INDEX IF NOT EXISTS volunteer_applications_email_key ON volunteer_applications (lower(email));
CREATE INDEX IF NOT EXISTS volunteer_applications_created_idx ON volunteer_applications (created_at DESC);

-- Only the server (service key) reads/writes this table.
ALTER TABLE volunteer_applications ENABLE ROW LEVEL SECURITY;


-- ---------------------------------------------------------------------------
-- Handy queries
-- ---------------------------------------------------------------------------
-- All sign-ups, newest first:
-- SELECT created_at, first_name, last_name, email, phone, age, roles, availability, status
-- FROM volunteer_applications ORDER BY created_at DESC;

-- How many people signed up for each area:
-- SELECT r AS area, COUNT(*) FROM volunteer_applications, unnest(roles) AS r GROUP BY r ORDER BY 2 DESC;
