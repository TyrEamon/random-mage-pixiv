CREATE TABLE IF NOT EXISTS images (
  id INTEGER PRIMARY KEY,
  illust_id INTEGER NOT NULL,
  page_index INTEGER NOT NULL DEFAULT 0,
  ext TEXT NOT NULL,
  width INTEGER,
  height INTEGER,
  orientation INTEGER,
  pixels INTEGER,
  x_restrict INTEGER,
  ai_type INTEGER,
  illust_type INTEGER,
  bookmark_count INTEGER,
  view_count INTEGER,
  comment_count INTEGER,
  user_id INTEGER,
  user_name TEXT,
  title TEXT,
  created_at_pixiv TEXT,
  original_url TEXT,
  random_key REAL NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  UNIQUE(illust_id, page_index)
);

CREATE INDEX IF NOT EXISTS idx_images_random
  ON images(enabled, x_restrict, random_key);

CREATE INDEX IF NOT EXISTS idx_images_illust
  ON images(illust_id, page_index);

CREATE TABLE IF NOT EXISTS image_tags (
  image_id INTEGER NOT NULL,
  tag TEXT NOT NULL,
  PRIMARY KEY(image_id, tag),
  FOREIGN KEY(image_id) REFERENCES images(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_image_tags_tag
  ON image_tags(tag, image_id);

CREATE TABLE IF NOT EXISTS tags (
  tag TEXT PRIMARY KEY,
  image_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS authors (
  user_id INTEGER PRIMARY KEY,
  user_name TEXT,
  image_count INTEGER NOT NULL DEFAULT 0
);
