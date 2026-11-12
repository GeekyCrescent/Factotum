/**
 * The schema of `jobs.db`, as text, by version (design D2).
 *
 * `MIGRATIONS[i]` takes the store from version `i` to `i + 1`; `PRAGMA user_version` is the version.
 * A migration is only ever APPENDED: one already shipped is never edited, because a store that ran
 * it will not run it again.
 *
 * Every table is `STRICT`: SQLite would otherwise keep a string in an INTEGER column without a word.
 * `data` (and the other JSON columns) holds what is never queried.
 */

const V1 = `
CREATE TABLE companies (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  name_key           TEXT NOT NULL UNIQUE,
  domain             TEXT,
  website            TEXT,
  careers_url        TEXT,
  ats_kind           TEXT,
  ats_ref            TEXT,
  is_health_employer INTEGER NOT NULL DEFAULT 0,
  health_source      TEXT,
  data               TEXT NOT NULL DEFAULT '{}',
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
) STRICT;

CREATE TABLE contacts (
  id             TEXT PRIMARY KEY,
  company_id     TEXT NOT NULL REFERENCES companies (id),
  name           TEXT,
  role           TEXT,
  email          TEXT,
  source_url     TEXT,
  address_status TEXT,
  verified_url   TEXT,
  checked_at     TEXT,
  override_at    TEXT
) STRICT;
CREATE INDEX contacts_by_company ON contacts (company_id);
CREATE INDEX contacts_by_status ON contacts (address_status);

CREATE TABLE opportunities (
  id              TEXT PRIMARY KEY,
  company_id      TEXT NOT NULL REFERENCES companies (id),
  kind            TEXT NOT NULL,
  title           TEXT NOT NULL,
  goal_id         TEXT,
  url             TEXT,
  dedupe_key      TEXT NOT NULL UNIQUE,
  source          TEXT NOT NULL,
  source_ref      TEXT,
  posted_at       TEXT,
  closes_at       TEXT,
  score           INTEGER,
  breakdown       TEXT,
  profile_version INTEGER,
  status          TEXT NOT NULL DEFAULT 'open',
  discard_reason  TEXT,
  checked_at      TEXT,
  data            TEXT NOT NULL DEFAULT '{}'
) STRICT;

CREATE TABLE applications (
  id             TEXT PRIMARY KEY,
  opportunity_id TEXT NOT NULL REFERENCES opportunities (id),
  company_id     TEXT NOT NULL REFERENCES companies (id),
  contact_id     TEXT REFERENCES contacts (id),
  seed_key       TEXT UNIQUE,
  channel        TEXT NOT NULL,
  target         TEXT NOT NULL DEFAULT '{}',
  cv_base        TEXT,
  state          TEXT NOT NULL,
  outcome        TEXT,
  rewrite_from   TEXT,
  hold_until     TEXT,
  version        INTEGER NOT NULL DEFAULT 0,
  notes          TEXT NOT NULL DEFAULT '',
  warnings       TEXT NOT NULL DEFAULT '[]',
  test           INTEGER NOT NULL DEFAULT 0,
  checks         TEXT NOT NULL DEFAULT '{}',
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
) STRICT;
CREATE INDEX applications_by_state ON applications (state);
CREATE INDEX applications_by_contact ON applications (contact_id);

CREATE TABLE gen_requests (
  entity_id TEXT NOT NULL,
  kind      TEXT NOT NULL,
  work_id   TEXT NOT NULL,
  PRIMARY KEY (entity_id, kind)
) STRICT;

CREATE TABLE followups (
  id             TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES applications (id),
  n              INTEGER NOT NULL,
  channel        TEXT NOT NULL,
  contact_id     TEXT REFERENCES contacts (id),
  state          TEXT NOT NULL,
  rewrite_from   TEXT,
  version        INTEGER NOT NULL,
  warnings       TEXT NOT NULL DEFAULT '[]',
  data           TEXT NOT NULL DEFAULT '{}',
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  UNIQUE (application_id, n)
) STRICT;
CREATE INDEX followups_by_contact ON followups (contact_id);

CREATE TABLE sends (
  application_id   TEXT NOT NULL REFERENCES applications (id),
  kind             TEXT NOT NULL,
  followup_id      TEXT REFERENCES followups (id),
  channel          TEXT NOT NULL,
  message_id       TEXT UNIQUE,
  state            TEXT NOT NULL,
  at               TEXT NOT NULL,
  response         TEXT,
  reason           TEXT,
  address_override INTEGER NOT NULL DEFAULT 0,
  profile_version  INTEGER,
  attempts         TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (application_id, kind)
) STRICT;
CREATE INDEX sends_by_state ON sends (state);

CREATE TABLE artifacts (
  application_id  TEXT NOT NULL REFERENCES applications (id),
  version         INTEGER NOT NULL,
  content         TEXT NOT NULL,
  pdf             TEXT,
  png             TEXT,
  contact_hash    TEXT,
  profile_version INTEGER NOT NULL,
  rules           TEXT NOT NULL DEFAULT '[]',
  usage           TEXT,
  created_at      TEXT NOT NULL,
  PRIMARY KEY (application_id, version)
) STRICT;

CREATE TABLE events (
  id             TEXT PRIMARY KEY,
  at             TEXT NOT NULL,
  recorded_at    TEXT NOT NULL,
  application_id TEXT,
  company_id     TEXT,
  kind           TEXT NOT NULL,
  data           TEXT NOT NULL DEFAULT '{}'
) STRICT;
CREATE INDEX events_by_application ON events (application_id, id);

CREATE TABLE rules (
  id         TEXT PRIMARY KEY,
  text       TEXT NOT NULL,
  scope      TEXT NOT NULL,
  enabled    INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE profile_versions (
  version    INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL,
  data       TEXT NOT NULL
) STRICT;

CREATE TABLE batches (
  id         TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  items      TEXT NOT NULL DEFAULT '[]',
  cursor     INTEGER NOT NULL DEFAULT 0,
  results    TEXT NOT NULL DEFAULT '{}',
  closed_at  TEXT
) STRICT;

CREATE TABLE work (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  ref        TEXT NOT NULL,
  lane       TEXT NOT NULL,
  state      TEXT NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  not_before TEXT,
  reason     TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX work_by_state ON work (state);

CREATE TABLE mail_seen (
  key            TEXT PRIMARY KEY,
  uidvalidity    INTEGER,
  uid            INTEGER,
  message_id     TEXT,
  seen_at        TEXT NOT NULL,
  application_id TEXT,
  class          TEXT
) STRICT;

CREATE TABLE sources (
  id            TEXT PRIMARY KEY,
  state         TEXT NOT NULL,
  last_ok_at    TEXT,
  failing_since TEXT,
  reason        TEXT
) STRICT;

CREATE TABLE proposals (
  id          TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL,
  section     TEXT NOT NULL,
  old         TEXT NOT NULL,
  new         TEXT NOT NULL,
  source_note TEXT,
  label       TEXT,
  why         TEXT,
  state       TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  decided_at  TEXT
) STRICT;

CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE TRIGGER events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'append-only'); END;
`

export const MIGRATIONS: readonly string[] = [V1]

export const SCHEMA_VERSION = MIGRATIONS.length
