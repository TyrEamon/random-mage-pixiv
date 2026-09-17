CREATE TABLE IF NOT EXISTS catalog_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO catalog_state(key, value) VALUES
  ('schema_version', '1'),
  ('import_status', 'empty'),
  ('images', '0'),
  ('works', '0'),
  ('tags', '0');
