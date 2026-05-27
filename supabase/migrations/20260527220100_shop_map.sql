-- Sprint 2: shop_map table
-- Replaces GAS Script's Shop tab (A=keyword, B=icon_url)
-- Edge function resolves shop icon server-side before writing to Google Sheet

CREATE TABLE IF NOT EXISTS shop_map (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  keyword      TEXT NOT NULL,           -- raw shop name from transaction (K: ShopSource)
  display_name TEXT,                    -- human label shown in D col
  icon_url     TEXT,                    -- if starts with http → IMAGE() in sheet
  match_mode   TEXT NOT NULL DEFAULT 'exact'
    CHECK (match_mode IN ('exact', 'ilike', 'prefix')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS shop_map_keyword_uidx ON shop_map (lower(keyword));

COMMENT ON TABLE shop_map IS 'Maps raw shop names (K: ShopSource) to display name / icon URL. Replaces GAS Shop tab VLOOKUP.';

-- Seed with Shopee default (same as GAS ensureShopSheet default)
INSERT INTO shop_map (keyword, display_name, icon_url, match_mode)
VALUES
  ('Shopee',    'Shopee',    'https://upload.wikimedia.org/wikipedia/commons/thumb/f/fe/Shopee.svg/1200px-Shopee.svg.png', 'ilike'),
  ('Lazada',    'Lazada',    'https://upload.wikimedia.org/wikipedia/commons/a/a2/Lazada_Logo.svg', 'ilike'),
  ('Grab',      'Grab',      'https://upload.wikimedia.org/wikipedia/commons/thumb/b/b8/Grab_logo_2019.svg/1200px-Grab_logo_2019.svg.png', 'ilike'),
  ('GrabFood',  'GrabFood',  'https://upload.wikimedia.org/wikipedia/commons/thumb/b/b8/Grab_logo_2019.svg/1200px-Grab_logo_2019.svg.png', 'ilike'),
  ('Tiki',      'Tiki',      'https://upload.wikimedia.org/wikipedia/commons/thumb/6/66/Tiki_Logo.png/1200px-Tiki_Logo.png', 'ilike')
ON CONFLICT (lower(keyword)) DO NOTHING;

-- RLS
ALTER TABLE shop_map ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_all" ON shop_map TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "anon_read"        ON shop_map FOR SELECT TO anon USING (true);
CREATE POLICY "auth_read"        ON shop_map FOR SELECT TO authenticated USING (true);
