-- Sprint 2: Add Google Sheet tracking columns to people
-- Resolves: sheet ID managed in DB instead of env vars / GAS Script Properties

ALTER TABLE people
  ADD COLUMN IF NOT EXISTS sheet_id        TEXT,
  ADD COLUMN IF NOT EXISTS sheet_url       TEXT,
  ADD COLUMN IF NOT EXISTS sheet_enabled   BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS sheet_cycle_mode TEXT NOT NULL DEFAULT 'month'
    CHECK (sheet_cycle_mode IN ('month', 'year'));

COMMENT ON COLUMN people.sheet_id        IS 'Google Spreadsheet ID (from URL). Managed in DB, replaces GAS Script Properties.';
COMMENT ON COLUMN people.sheet_url       IS 'Full Google Sheets URL for convenience link in admin UI.';
COMMENT ON COLUMN people.sheet_enabled   IS 'Toggle sheet sync on/off per person without removing sheet_id.';
COMMENT ON COLUMN people.sheet_cycle_mode IS 'month = one tab per YYYY-MM | year = one tab per YYYY (master sheet mode).';

-- Index for quick lookup when edge function resolves sheet by person_id
CREATE INDEX IF NOT EXISTS idx_people_sheet_enabled
  ON people (id)
  WHERE sheet_enabled = true;
