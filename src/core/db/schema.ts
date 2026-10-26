/**
 * Schema and migrations.
 *
 * `person` is the single source of truth for a human being: a birthday card is a
 * view over it, and the family tree is `person` + family units. Keeping one
 * entity is what stops the same person existing three times with three slightly
 * different names.
 *
 * Relationships follow GEDCOM 7's two-record model: a `family` row is a union of
 * up to two partners, and `family_child` attaches children to it with an explicit
 * pedigree (亲生 / 过继 / 收养 / 继子女 / 入赘). That model is why an earlier
 * parent/spouse edge table was dropped: an edge cannot say which marriage a child
 * belongs to, and storing "sibling" would have been derived data that drifts.
 *
 * `id` is a UUID rather than an autoincrement integer, and rows are removed with
 * `deleted_at` instead of DELETE, because both are required before two devices
 * can merge their data without duplicating or resurrecting records.
 */

export const SCHEMA_VERSION = 6;

/** Person columns added in v2, applied to databases created before it. */
export const PERSON_COLUMN_ADDITIONS: Array<{ name: string; ddl: string }> = [
  { name: 'generation', ddl: 'ALTER TABLE person ADD COLUMN generation INTEGER' },
  { name: 'generation_char', ddl: 'ALTER TABLE person ADD COLUMN generation_char TEXT' },
  { name: 'courtesy_name', ddl: 'ALTER TABLE person ADD COLUMN courtesy_name TEXT' },
  { name: 'art_name', ddl: 'ALTER TABLE person ADD COLUMN art_name TEXT' },
  { name: 'ranking', ddl: 'ALTER TABLE person ADD COLUMN ranking TEXT' },
  { name: 'native_place', ddl: 'ALTER TABLE person ADD COLUMN native_place TEXT' },
  { name: 'burial_place', ddl: 'ALTER TABLE person ADD COLUMN burial_place TEXT' },
  { name: 'death_date', ddl: 'ALTER TABLE person ADD COLUMN death_date TEXT' },
];

export const DDL = `
CREATE TABLE IF NOT EXISTS person (
  id                   TEXT PRIMARY KEY,
  name                 TEXT NOT NULL,
  gender               TEXT NOT NULL DEFAULT 'unspecified',
  relation_label       TEXT,
  note                 TEXT,
  calendar_system      TEXT,
  date_fields_json     TEXT,
  birth_timezone       TEXT,
  shichen              TEXT,
  gregorian_local_date TEXT,
  zodiac_sign          TEXT,
  shengxiao            TEXT,
  is_self              INTEGER NOT NULL DEFAULT 0,
  -- 中式著录
  generation           INTEGER,
  generation_char      TEXT,
  courtesy_name        TEXT,
  art_name             TEXT,
  ranking              TEXT,
  native_place         TEXT,
  burial_place         TEXT,
  death_date           TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  deleted_at           TEXT
);


-- 家庭单元（GEDCOM FAM）：一对配偶 + 其子女
CREATE TABLE IF NOT EXISTS family (
  id            TEXT PRIMARY KEY,
  husband_id    TEXT REFERENCES person(id),
  wife_id       TEXT REFERENCES person(id),
  kind          TEXT NOT NULL DEFAULT 'marriage',
  marriage_date TEXT,
  divorce_date  TEXT,
  note          TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  deleted_at    TEXT
);


-- 子女隶属某家庭单元，并记录入嗣方式
CREATE TABLE IF NOT EXISTS family_child (
  id          TEXT PRIMARY KEY,
  family_id   TEXT NOT NULL REFERENCES family(id),
  child_id    TEXT NOT NULL REFERENCES person(id),
  pedigree    TEXT NOT NULL DEFAULT 'birth',
  birth_order INTEGER,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  deleted_at  TEXT
);


CREATE TABLE IF NOT EXISTS countdown (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  target_date TEXT NOT NULL,
  timezone    TEXT NOT NULL DEFAULT 'Asia/Shanghai',
  all_day     INTEGER NOT NULL DEFAULT 1,
  color       TEXT,
  pinned      INTEGER NOT NULL DEFAULT 0,
  note        TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  deleted_at  TEXT
);

CREATE TABLE IF NOT EXISTS note (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  body_md    TEXT NOT NULL DEFAULT '',
  pinned     INTEGER NOT NULL DEFAULT 0,
  tags_json  TEXT,
  person_id  TEXT REFERENCES person(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

-- Note images live in the database, not on a filesystem: this app has no server,
-- and OPFS files would need their own garbage collection. The blob is already
-- downscaled to ≤1920px + WebP by the browser before it gets here, so a note with
-- nine pictures is still a few hundred KB.
CREATE TABLE IF NOT EXISTS note_image (
  id         TEXT PRIMARY KEY,
  note_id    TEXT NOT NULL REFERENCES note(id),
  mime       TEXT NOT NULL,
  width      INTEGER NOT NULL DEFAULT 0,
  height     INTEGER NOT NULL DEFAULT 0,
  bytes      BLOB NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS setting (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS app_meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS weather_cache (
  location_key TEXT PRIMARY KEY,
  fetched_at   TEXT NOT NULL,
  payload_json TEXT NOT NULL
);


-- One row per focus session. The running timer is derived from start_time rather
-- than a stored counter, so a reload (or a closed tab) cannot lose the elapsed
-- time: end_time IS NULL means "still going".
CREATE TABLE IF NOT EXISTS focus_session (
  id              TEXT PRIMARY KEY,
  task_label      TEXT,
  mode            TEXT NOT NULL,
  planned_seconds INTEGER NOT NULL DEFAULT 0,
  start_time      TEXT NOT NULL,
  end_time        TEXT,
  duration_seconds INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL
);


-- Goals (目标倒计时). A goal is quantity-based or result-based; check-ins live
-- in goal_log and may target a sub-goal (e.g. one book of a reading goal).
CREATE TABLE IF NOT EXISTS goal (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'qty',
  target        REAL NOT NULL DEFAULT 0,
  unit          TEXT NOT NULL DEFAULT '',
  initial_done  REAL NOT NULL DEFAULT 0,
  start_value   REAL NOT NULL DEFAULT 0,
  target_value  REAL NOT NULL DEFAULT 0,
  direction     INTEGER NOT NULL DEFAULT 1,
  start_at      TEXT NOT NULL,
  due_at        TEXT NOT NULL,
  ended_at      TEXT,
  max_per_day   INTEGER NOT NULL DEFAULT 0,
  pattern       TEXT NOT NULL DEFAULT '0',
  shape         TEXT NOT NULL DEFAULT 'front',
  color         TEXT NOT NULL DEFAULT '#2f4bff',
  archived      INTEGER NOT NULL DEFAULT 0,
  voided        INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

-- Sub-goals: a reading goal can track one book at a time (《小王子》).
CREATE TABLE IF NOT EXISTS goal_sub (
  id            TEXT PRIMARY KEY,
  goal_id       TEXT NOT NULL REFERENCES goal(id),
  name          TEXT NOT NULL,
  unit          TEXT NOT NULL DEFAULT '',
  total         REAL NOT NULL DEFAULT 0,
  position      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL
);

-- One row per check-in. note_id links a check-in to the note it produced.
CREATE TABLE IF NOT EXISTS goal_log (
  id            TEXT PRIMARY KEY,
  goal_id       TEXT NOT NULL REFERENCES goal(id),
  sub_id        TEXT REFERENCES goal_sub(id),
  amount        REAL NOT NULL DEFAULT 0,
  value         REAL,
  position      REAL,
  note          TEXT NOT NULL DEFAULT '',
  note_id       TEXT REFERENCES note(id),
  at            TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

-- ── 词光 atlas ───────────────────────────────────────────────────────────────
--
-- 词条正文来自 word-atlas 的开放词库（CC BY 4.0）。只有「文本」进数据库：
-- 7,298 个词条约 7 MB，可以整库装进来做全文检索和随机出题。插画和音频有 551 MB，
-- 绝不进数据库 —— 它们在媒体源里按需取（见 core/word/media.ts），这里只记从
-- word-atlas 带来的媒体位标志。
CREATE TABLE IF NOT EXISTS word_entry (
  id          TEXT PRIMARY KEY,            -- 词 id，例如 abandon
  word        TEXT NOT NULL,
  ipa_uk      TEXT NOT NULL DEFAULT '',
  ipa_us      TEXT NOT NULL DEFAULT '',
  cefr        TEXT NOT NULL DEFAULT '',    -- A1…C2
  topic       TEXT NOT NULL DEFAULT '',
  -- 媒体位标志：1 插画、2 英音、4 美音、8 例句朗读、16 第二例句朗读。
  media       INTEGER NOT NULL DEFAULT 0,
  -- JSON：义项、例句、搭配、词族、近反义、提示
  senses_json TEXT NOT NULL DEFAULT '[]',
  ex_json     TEXT NOT NULL DEFAULT '[]',
  col_json    TEXT NOT NULL DEFAULT '[]',
  fam_json    TEXT NOT NULL DEFAULT '[]',
  syn_json    TEXT NOT NULL DEFAULT '[]',
  ant_json    TEXT NOT NULL DEFAULT '[]',
  tip         TEXT NOT NULL DEFAULT '',
  note        TEXT NOT NULL DEFAULT '',
  -- 学习路径里的位置，决定「每天 20 个新词」按什么顺序出
  ord         INTEGER NOT NULL DEFAULT 0
);

-- 一个词的个人学习状态（FSRS 卡片）。日期一律存 epoch 毫秒。
CREATE TABLE IF NOT EXISTS word_card (
  word_id        TEXT PRIMARY KEY REFERENCES word_entry(id),
  due            INTEGER NOT NULL,
  stability      REAL NOT NULL DEFAULT 0,
  difficulty     REAL NOT NULL DEFAULT 0,
  elapsed_days   REAL NOT NULL DEFAULT 0,
  scheduled_days REAL NOT NULL DEFAULT 0,
  learning_steps INTEGER NOT NULL DEFAULT 0,
  reps           INTEGER NOT NULL DEFAULT 0,
  lapses         INTEGER NOT NULL DEFAULT 0,
  state          INTEGER NOT NULL DEFAULT 0,   -- 0 新 1 学习中 2 复习 3 重学
  last_review    INTEGER,
  first_seen     INTEGER NOT NULL,
  bookmarked     INTEGER NOT NULL DEFAULT 0,
  updated_at     TEXT NOT NULL
);

-- 每天的学习量，用于「今日进度」和连续天数。
CREATE TABLE IF NOT EXISTS word_day (
  day            TEXT PRIMARY KEY,             -- YYYY-MM-DD（本地日）
  new_count      INTEGER NOT NULL DEFAULT 0,
  review_count   INTEGER NOT NULL DEFAULT 0,
  correct_count  INTEGER NOT NULL DEFAULT 0,
  active_seconds INTEGER NOT NULL DEFAULT 0
);

-- 词集：可以来自笔记（提取生词）、读书目标（书名）、或自己新建。
CREATE TABLE IF NOT EXISTS word_set (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'custom',   -- custom | note | goal | all
  source_id  TEXT,                             -- note.id 或 goal_sub.id
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS word_set_item (
  set_id   TEXT NOT NULL REFERENCES word_set(id),
  word_id  TEXT NOT NULL REFERENCES word_entry(id),
  added_at TEXT NOT NULL,
  PRIMARY KEY (set_id, word_id)
);

-- 错词本：只在错的时候记一笔，答对不删（保留历史）。
CREATE TABLE IF NOT EXISTS word_mistake (
  word_id  TEXT PRIMARY KEY REFERENCES word_entry(id),
  count    INTEGER NOT NULL DEFAULT 1,
  last_at  INTEGER NOT NULL
);
`;
/**
 * Indexes, kept separate from {@link DDL} on purpose.
 *
 * `CREATE TABLE IF NOT EXISTS` never adds missing columns, so an index over a
 * v2 column would fail on a database created by an older build — and because the
 * whole DDL ran as one batch, that failure aborted the migration BEFORE the
 * columns were added, leaving the app unusable. Tables are therefore applied
 * first, then the columns are reconciled, and only then are indexes created.
 */
export const DDL_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_person_live ON person (deleted_at, name);
CREATE INDEX IF NOT EXISTS idx_person_generation ON person (deleted_at, generation);
CREATE INDEX IF NOT EXISTS idx_family_husband ON family (husband_id, deleted_at);
CREATE INDEX IF NOT EXISTS idx_family_wife ON family (wife_id, deleted_at);
CREATE INDEX IF NOT EXISTS idx_family_child_child ON family_child (child_id, deleted_at);
CREATE INDEX IF NOT EXISTS idx_family_child_family ON family_child (family_id, deleted_at);
CREATE INDEX IF NOT EXISTS idx_note_live ON note (deleted_at, pinned DESC, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_note_image_note ON note_image (note_id);
CREATE INDEX IF NOT EXISTS idx_focus_start ON focus_session (start_time);
CREATE INDEX IF NOT EXISTS idx_focus_open ON focus_session (end_time);
CREATE INDEX IF NOT EXISTS idx_goal_sub ON goal_sub (goal_id);
CREATE INDEX IF NOT EXISTS idx_goal_log ON goal_log (goal_id, at);
CREATE INDEX IF NOT EXISTS idx_word_entry_ord ON word_entry (ord);
CREATE INDEX IF NOT EXISTS idx_word_entry_cefr ON word_entry (cefr, ord);
CREATE INDEX IF NOT EXISTS idx_word_card_due ON word_card (due);
CREATE INDEX IF NOT EXISTS idx_word_set_item_word ON word_set_item (word_id);
`;

/** Columns `person` must have after migration; verified at open time. */
export const REQUIRED_PERSON_COLUMNS = [
  'id', 'name', 'gender', 'relation_label', 'note', 'calendar_system',
  'date_fields_json', 'birth_timezone', 'shichen', 'gregorian_local_date',
  'zodiac_sign', 'shengxiao', 'is_self', 'generation', 'generation_char',
  'courtesy_name', 'art_name', 'ranking', 'native_place', 'burial_place',
  'death_date', 'created_at', 'updated_at',
];
/** Tables that must exist after migration; verified at open time. */
export const REQUIRED_TABLES = [
  'person', 'family', 'family_child', 'countdown', 'note', 'note_image', 'focus_session', 'goal', 'goal_sub', 'goal_log',
  'word_entry', 'word_card', 'word_day', 'word_set', 'word_set_item', 'word_mistake',
  'setting', 'app_meta', 'weather_cache',
];