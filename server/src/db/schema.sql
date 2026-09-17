-- Fauxr schema. Single user, SQLite. All timestamps are ISO-8601 UTC strings.

CREATE TABLE IF NOT EXISTS user_profile (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  display_name  TEXT NOT NULL,
  age           INTEGER NOT NULL,
  bio           TEXT NOT NULL DEFAULT '',
  photos        TEXT NOT NULL DEFAULT '[]',
  gender        TEXT NOT NULL DEFAULT '',
  seeking       TEXT NOT NULL DEFAULT '',
  age_min       INTEGER NOT NULL DEFAULT 18,
  age_max       INTEGER NOT NULL DEFAULT 42,
  kink_map      TEXT NOT NULL DEFAULT '{}',
  avatar_emoji  TEXT NOT NULL DEFAULT '',
  card          TEXT NOT NULL DEFAULT '{}',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS characters (
  id               TEXT PRIMARY KEY,
  username         TEXT NOT NULL,
  real_name        TEXT NOT NULL,
  bio              TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  state            TEXT NOT NULL DEFAULT 'pool',
  seed             TEXT NOT NULL,
  reappear_at      TEXT,
  rejection_count  INTEGER NOT NULL DEFAULT 0,
  matched_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_characters_state ON characters(state);
CREATE UNIQUE INDEX IF NOT EXISTS idx_characters_username ON characters(username);

CREATE TABLE IF NOT EXISTS relationships (
  character_id     TEXT PRIMARY KEY REFERENCES characters(id) ON DELETE CASCADE,
  trust            INTEGER NOT NULL DEFAULT 10,
  spark            INTEGER NOT NULL DEFAULT 20,
  investment       INTEGER NOT NULL DEFAULT 15,
  reciprocity      REAL    NOT NULL DEFAULT 0.5,
  pressure         REAL    NOT NULL DEFAULT 0,
  mood             TEXT    NOT NULL DEFAULT '{}',
  her_tension      INTEGER NOT NULL DEFAULT 0,
  user_tension     INTEGER NOT NULL DEFAULT 0,
  arousal          INTEGER NOT NULL DEFAULT 0,
  discovered       TEXT    NOT NULL DEFAULT '{}',
  last_contact_at  TEXT,
  last_decay_at    TEXT,
  flags            TEXT    NOT NULL DEFAULT '{}',
  ledger           TEXT    NOT NULL DEFAULT '{}',
  active_direction TEXT,
  direction_set_at TEXT,
  ghosted_at       TEXT
);

CREATE TABLE IF NOT EXISTS messages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  character_id  TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  sender        TEXT NOT NULL,               -- 'user' | 'character' | 'system'
  text          TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'text',-- text | voice | image
  meta          TEXT NOT NULL DEFAULT '{}',
  sent_at       TEXT NOT NULL,
  read_at       TEXT,
  -- NULL for the text chat. Set to a dates.id for anything said in person during a date,
  -- which is a separate transcript the texting history never mixes with.
  date_id       TEXT REFERENCES dates(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_messages_char ON messages(character_id, id);
CREATE INDEX IF NOT EXISTS idx_messages_date ON messages(date_id, id);

CREATE TABLE IF NOT EXISTS wakeups (
  character_id          TEXT PRIMARY KEY REFERENCES characters(id) ON DELETE CASCADE,
  scheduled_at          TEXT NOT NULL,
  reason                TEXT NOT NULL DEFAULT '',
  cancel_if_user_writes INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_wakeups_due ON wakeups(scheduled_at);

-- Places the player writes themselves, in Settings, and can then take someone to.
CREATE TABLE IF NOT EXISTS locations (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  -- Relative to the images directory, same as any generated picture. Optional: a location
  -- works fine without one, it just has no backdrop behind the date.
  image_path   TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS dates (
  id            TEXT PRIMARY KEY,
  character_id  TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  status        TEXT NOT NULL DEFAULT 'proposed',  -- active | ended
  when_at       TEXT,
  -- The location's name copied in at the time, so an old date still reads correctly after
  -- the place it happened in has been renamed or deleted.
  where_at      TEXT,
  location_id   TEXT REFERENCES locations(id) ON DELETE SET NULL,
  proposed_by   TEXT,
  confirmed_by  TEXT,
  summary       TEXT,
  created_at    TEXT NOT NULL,
  ended_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_dates_char ON dates(character_id, created_at);

CREATE TABLE IF NOT EXISTS images (
  id            TEXT PRIMARY KEY,
  character_id  TEXT REFERENCES characters(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,
  prompt        TEXT NOT NULL DEFAULT '',
  seed          INTEGER,
  ref_image     TEXT,
  status        TEXT NOT NULL DEFAULT 'queued',
  path          TEXT,
  error         TEXT,
  aspect        TEXT,
  shows_face    INTEGER NOT NULL DEFAULT 1,
  situation     TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS attribute_db (
  id           TEXT NOT NULL,
  category     TEXT NOT NULL,
  label        TEXT NOT NULL,
  weight       REAL NOT NULL DEFAULT 1.0,
  rarity       TEXT NOT NULL DEFAULT 'common',
  prompt_hint  TEXT NOT NULL DEFAULT '',
  image_prompt TEXT,
  affinities   TEXT NOT NULL DEFAULT '[]',
  conflicts    TEXT NOT NULL DEFAULT '[]',
  modifies     TEXT NOT NULL DEFAULT '{}',
  extra        TEXT NOT NULL DEFAULT '{}',
  enabled      INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (category, id)
);

CREATE TABLE IF NOT EXISTS logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         TEXT NOT NULL,
  level      TEXT NOT NULL,
  scope      TEXT NOT NULL,
  message    TEXT NOT NULL DEFAULT '',
  payload    TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs(id DESC);
CREATE INDEX IF NOT EXISTS idx_logs_scope ON logs(scope, id DESC);

CREATE TABLE IF NOT EXISTS usage_daily (
  day        TEXT PRIMARY KEY,
  calls      INTEGER NOT NULL DEFAULT 0,
  tokens_in  INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  cost       REAL NOT NULL DEFAULT 0
);
