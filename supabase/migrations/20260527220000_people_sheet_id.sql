-- Sprint 2A: Add sheet management columns to people table
-- Replaces GAS PropertiesService 'SHEET_' + personId pattern
-- Now managed in DB → queryable, listable, no manual env vars

ALTER TABLE people
  ADD COLUMN IF NOT EXISTS sheet_id       TEXT,
  ADD COLUMN IF NOT EXISTS sheet_url      TEXT,
  ADD COLUMN IF NOT EXISTS sheet_enabled  BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS sheet_tab_prefix TEXT DEFAULT NULL; -- optional: override tab prefix per person

COMMENT ON COLUMN people.sheet_id      IS 'Google Spreadsheet ID for this person (replaces GAS PropertiesService SHEET_{personId})';
COMMENT ON COLUMN people.sheet_url     IS 'Full URL to the Google Sheet (convenience)';
COMMENT ON COLUMN people.sheet_enabled IS 'Whether sheet sync is active for this person';
COMMENT ON COLUMN people.sheet_tab_prefix IS 'Optional: custom tab name prefix (default: cycle tag YYYY-MM)';

-- Index for quick lookup in edge function
CREATE INDEX IF NOT EXISTS idx_people_sheet_id ON people(sheet_id) WHERE sheet_id IS NOT NULL;

-- shop_map: replaces Shop!A:B tab in GAS spreadsheet
-- keyword → icon_url / display_name VLOOKUP
CREATE TABLE IF NOT EXISTS shop_map (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  keyword      TEXT NOT NULL UNIQUE,   -- raw shop name key (case-insensitive match)
  display_name TEXT,                   -- human-readable shop name
  icon_url     TEXT,                   -- URL for IMAGE() formula OR direct display
  category_hint TEXT,                  -- optional: suggest category_id
  is_active    BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE shop_map IS 'Replaces GAS Shop tab VLOOKUP. Maps raw shop keywords to display names and icons.';

CREATE INDEX IF NOT EXISTS idx_shop_map_keyword ON shop_map(lower(keyword));

-- Seed basic shops (can expand via UI)
INSERT INTO shop_map (keyword, display_name, icon_url) VALUES
  ('Shopee',      'Shopee',       'https://cf.shopee.vn/file/vn-50009109-b5e0e89f4be1c4da5b4bdce98ca7620c'),
  ('Lazada',      'Lazada',       'https://lzd-img-global.slatic.net/g/tsp/tfs/TB1...lazada.png'),
  ('Grab',        'Grab',         'https://upload.wikimedia.org/wikipedia/commons/thumb/6/63/Grab_Logo.png/200px-Grab_Logo.png'),
  ('VinMart',     'VinMart+',     NULL),
  ('Circle K',    'Circle K',     NULL),
  ('FamilyMart',  'FamilyMart',   NULL),
  ('MoMo',        'MoMo',         NULL),
  ('ZaloPay',     'ZaloPay',      NULL),
  ('VNPay',       'VNPay',        NULL)
ON CONFLICT (keyword) DO NOTHING;

-- RLS for shop_map: readable by authenticated, writable by admin only
ALTER TABLE shop_map ENABLE ROW LEVEL SECURITY;

CREATE POLICY "shop_map_read_authenticated" ON shop_map
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "shop_map_write_service_role" ON shop_map
  FOR ALL TO service_role USING (true);

-- updated_at trigger for shop_map
CREATE TRIGGER shop_map_updated_at
  BEFORE UPDATE ON shop_map
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
