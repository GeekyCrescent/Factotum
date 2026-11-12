import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { openDb, type Db } from './db.ts'
import { MIGRATIONS, SCHEMA_VERSION } from './schema.sql.ts'
import { manualClock, tempBase } from '../test-support.ts'
import { fail, ok } from '../types.ts'

const NOW = '2026-11-14T03:04:05.000Z'
const mode = (path: string): number => statSync(path).mode & 0o777

async function open(dir: string, migrations?: readonly string[]): Promise<Db> {
  const opened = await openDb({ dir, now: manualClock(NOW).now, ...(migrations === undefined ? {} : { migrations }) })
  assert.ok(opened.ok, opened.ok ? '' : opened.error.reason)
  if (!opened.ok) throw new Error('unreachable')
  return opened.value
}

/** Writes a raw file with `user_version` set, through the same driver, outside `openDb`. */
async function rawDb(path: string, version: number): Promise<void> {
  const { DatabaseSync } = await import('node:sqlite')
  const handle = new DatabaseSync(path)
  handle.exec(`CREATE TABLE IF NOT EXISTS keep (x INTEGER) STRICT; INSERT INTO keep VALUES (1); PRAGMA user_version = ${version};`)
  handle.close()
}

const insertEvent = (db: Db, id: string): void => {
  const written = db.tx((q) => {
    q.run("INSERT INTO events (id, at, recorded_at, kind, data) VALUES (?, ?, ?, 'note', '{}')", id, NOW, NOW)
    return ok(undefined)
  })
  assert.ok(written.ok)
}

test('a new store opens at the current schema with WAL, foreign keys and a busy timeout', async () => {
  using base = tempBase()
  const db = await open(join(base.dir, 'state'))
  const pragmas = db.read((q) => ({
    version: q.get<{ user_version: number }>('PRAGMA user_version')?.user_version,
    journal: q.get<{ journal_mode: string }>('PRAGMA journal_mode')?.journal_mode,
    foreignKeys: q.get<{ foreign_keys: number }>('PRAGMA foreign_keys')?.foreign_keys,
    busy: q.get<{ timeout: number }>('PRAGMA busy_timeout')?.timeout,
  }))
  assert.deepEqual(pragmas, { version: SCHEMA_VERSION, journal: 'wal', foreignKeys: 1, busy: 2000 })
  assert.equal(SCHEMA_VERSION, MIGRATIONS.length)
  db.close()
})

test('the folder is 0700 and jobs.db, -wal and -shm are 0600 under a umask of 022 (R8)', async () => {
  using base = tempBase()
  const previous = process.umask(0o022)
  try {
    const dir = join(base.dir, 'state')
    const db = await open(dir)
    assert.equal(mode(dir), 0o700)
    for (const name of ['jobs.db', 'jobs.db-wal', 'jobs.db-shm']) {
      assert.ok(existsSync(join(dir, name)), name)
      assert.equal(mode(join(dir, name)), 0o600, name)
    }
    db.close()
  } finally {
    process.umask(previous)
  }
})

test('every table of v1 is STRICT, and the two triggers exist', async () => {
  using base = tempBase()
  const db = await open(base.dir)
  const tables = db.read((q) => q.all<{ name: string; strict: number }>("SELECT name, strict FROM pragma_table_list WHERE schema = 'main' AND name NOT LIKE 'sqlite_%'"))
  const names = tables.map((t) => t.name).sort()
  assert.deepEqual(names, [
    'applications',
    'artifacts',
    'batches',
    'companies',
    'contacts',
    'events',
    'followups',
    'gen_requests',
    'mail_seen',
    'meta',
    'opportunities',
    'profile_versions',
    'proposals',
    'rules',
    'sends',
    'sources',
    'work',
  ])
  assert.ok(tables.every((t) => t.strict === 1))
  const triggers = db.read((q) => q.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name"))
  assert.deepEqual(triggers.map((t) => t.name), ['events_no_delete', 'events_no_update'])
  db.close()
})

test('an UPDATE on events fails, and nothing changes (R6)', async () => {
  using base = tempBase()
  const db = await open(base.dir)
  insertEvent(db, 'e1')
  const updated = db.tx((q) => {
    q.run("UPDATE events SET kind = 'closed' WHERE id = 'e1'")
    return ok(undefined)
  })
  assert.equal(updated.ok, false)
  if (!updated.ok) assert.match(updated.error.reason, /append-only/)
  assert.equal(db.read((q) => q.get<{ kind: string }>("SELECT kind FROM events WHERE id = 'e1'"))?.kind, 'note')
  db.close()
})

test('a DELETE on events fails, and the row stays (R6)', async () => {
  using base = tempBase()
  const db = await open(base.dir)
  insertEvent(db, 'e1')
  const deleted = db.tx((q) => {
    q.run("DELETE FROM events WHERE id = 'e1'")
    return ok(undefined)
  })
  assert.equal(deleted.ok, false)
  if (!deleted.ok) assert.match(deleted.error.reason, /append-only/)
  assert.equal(db.read((q) => q.all('SELECT id FROM events')).length, 1)
  db.close()
})

test('a !ok from the body rolls the transaction back and is returned as is', async () => {
  using base = tempBase()
  const db = await open(base.dir)
  const result = db.tx((q) => {
    q.run("INSERT INTO meta (key, value) VALUES ('k', 'v')")
    return fail('conflict', 'changed its mind')
  })
  assert.deepEqual(result, { ok: false, error: { code: 'conflict', reason: 'changed its mind' } })
  assert.equal(db.read((q) => q.get("SELECT value FROM meta WHERE key = 'k'")), undefined)
  db.close()
})

test('a throw inside the body rolls back and becomes a Result, never a throw', async () => {
  using base = tempBase()
  const db = await open(base.dir)
  const result = db.tx((q) => {
    q.run("INSERT INTO meta (key, value) VALUES ('k', 'v')")
    throw new Error('boom')
  })
  assert.deepEqual(result, { ok: false, error: { code: 'module-error', reason: 'boom' } })
  assert.equal(db.read((q) => q.get("SELECT value FROM meta WHERE key = 'k'")), undefined)
  db.close()
})

test('a committed body is visible, and rows come back frozen', async () => {
  using base = tempBase()
  const db = await open(base.dir)
  const result = db.tx((q) => {
    const changed = q.run("INSERT INTO meta (key, value) VALUES ('k', 'v')")
    return ok(changed.changes)
  })
  assert.deepEqual(result, { ok: true, value: 1 })
  const row = db.read((q) => q.get<{ value: string }>("SELECT value FROM meta WHERE key = 'k'"))
  assert.deepEqual(row, { value: 'v' })
  assert.ok(Object.isFrozen(row))
  const rows = db.read((q) => q.all("SELECT value FROM meta"))
  assert.ok(Object.isFrozen(rows) && rows.every((r) => Object.isFrozen(r)))
  db.close()
})

test('a transaction inside a transaction is refused', async () => {
  using base = tempBase()
  const db = await open(base.dir)
  const outer = db.tx(() => db.tx(() => ok(1)))
  assert.equal(outer.ok, false)
  if (!outer.ok) assert.equal(outer.error.code, 'module-error')
  db.close()
})

test('a lower user_version migrates in one transaction: a v2 of test goes on top of v1', async () => {
  using base = tempBase()
  const first = await open(base.dir)
  insertEvent(first, 'e1')
  first.close()
  const v2 = [...MIGRATIONS, 'CREATE TABLE extra (id TEXT PRIMARY KEY) STRICT;']
  const db = await open(base.dir, v2)
  assert.equal(db.read((q) => q.get<{ user_version: number }>('PRAGMA user_version'))?.user_version, 2)
  assert.ok(db.read((q) => q.get("SELECT name FROM sqlite_master WHERE name = 'extra'")))
  assert.equal(db.read((q) => q.all('SELECT id FROM events')).length, 1)
  db.close()
})

test('a migration that fails rolls back, leaves the version, and comes back as a Result', async () => {
  using base = tempBase()
  ;(await open(base.dir)).close()
  const broken = [...MIGRATIONS, 'CREATE TABLE half (id TEXT) STRICT; THIS IS NOT SQL;']
  const opened = await openDb({ dir: base.dir, now: manualClock(NOW).now, migrations: broken })
  assert.equal(opened.ok, false)
  if (!opened.ok) assert.match(opened.error.reason, /migration to v2 failed/)
  const db = await open(base.dir)
  assert.equal(db.read((q) => q.get<{ user_version: number }>('PRAGMA user_version'))?.user_version, 1)
  assert.equal(db.read((q) => q.get("SELECT name FROM sqlite_master WHERE name = 'half'")), undefined)
  db.close()
})

test('a v99 store is not touched: copied to jobs.db.bad-<date> (0600) and refused with the reason', async () => {
  using base = tempBase()
  const file = join(base.dir, 'jobs.db')
  await rawDb(file, 99)
  const before = readFileSync(file)
  const opened = await openDb({ dir: base.dir, now: manualClock(NOW).now })
  assert.equal(opened.ok, false)
  if (!opened.ok) {
    assert.equal(opened.error.code, 'module-error')
    assert.match(opened.error.reason, /schema version 99 is newer than this code's 1/)
    assert.match(opened.error.reason, /jobs\.db\.bad-2026-11-14T03-04-05/)
  }
  assert.deepEqual(readFileSync(file), before)
  const bad = readdirSync(base.dir).filter((name) => name.startsWith('jobs.db.bad-'))
  assert.deepEqual(bad, ['jobs.db.bad-2026-11-14T03-04-05.000Z'])
  assert.equal(mode(join(base.dir, bad[0] ?? '')), 0o600)
})

test('a file that is not a database is copied aside and refused, without a throw', async () => {
  using base = tempBase()
  const file = join(base.dir, 'jobs.db')
  writeFileSync(file, 'this is not a database, not at all, just some text that is long enough'.repeat(20))
  const opened = await openDb({ dir: base.dir, now: manualClock(NOW).now })
  assert.equal(opened.ok, false)
  if (!opened.ok) assert.match(opened.error.reason, /jobs\.db does not open/)
  assert.ok(existsSync(join(base.dir, 'jobs.db.bad-2026-11-14T03-04-05.000Z')))
})

test('a damaged page fails integrity_check: copied aside and refused', async () => {
  using base = tempBase()
  const file = join(base.dir, 'jobs.db')
  const db = await open(base.dir)
  db.tx((q) => {
    for (let i = 0; i < 400; i += 1) q.run('INSERT INTO meta (key, value) VALUES (?, ?)', `k${i}`, 'x'.repeat(200))
    return ok(undefined)
  })
  db.read((q) => q.get('PRAGMA wal_checkpoint(TRUNCATE)'))
  db.close()
  const bytes = readFileSync(file)
  // The header of every b-tree page after the first: page 1 (the header and the schema) stays readable.
  const pageSize = bytes.readUInt16BE(16)
  for (let page = 1; page * pageSize < bytes.length; page += 1) bytes.fill(0xa5, page * pageSize, page * pageSize + 8)
  writeFileSync(file, bytes)
  const opened = await openDb({ dir: base.dir, now: manualClock(NOW).now })
  assert.equal(opened.ok, false)
  if (!opened.ok) assert.match(opened.error.reason, /integrity|does not open/)
  assert.ok(existsSync(join(base.dir, 'jobs.db.bad-2026-11-14T03-04-05.000Z')))
})

test('a Node without node:sqlite gives a Result with the reason and does not throw (N4)', async () => {
  using base = tempBase()
  const opened = await openDb({ dir: base.dir, now: manualClock(NOW).now, load: () => Promise.reject(new Error('No such built-in module: node:sqlite')) })
  assert.equal(opened.ok, false)
  if (!opened.ok) {
    assert.equal(opened.error.code, 'module-error')
    assert.equal(opened.error.reason, `node:sqlite is not available in Node ${process.versions.node}; jobs needs >= 22.13`)
  }
  assert.equal(existsSync(join(base.dir, 'jobs.db')), false)
})

test('backup writes a VACUUM INTO copy, 0600 in a 0700 folder under a umask of 022, with the data', async () => {
  using base = tempBase()
  const previous = process.umask(0o022)
  try {
    const db = await open(base.dir)
    insertEvent(db, 'e1')
    const to = join(base.dir, 'backups', 'jobs-2026-11-14.db')
    assert.deepEqual(db.backup(to), { ok: true, value: undefined })
    assert.equal(mode(to), 0o600)
    assert.equal(mode(join(base.dir, 'backups')), 0o700)
    db.close()
    const copy = await open(join(base.dir, 'restore'))
    copy.close()
    const { DatabaseSync } = await import('node:sqlite')
    const handle = new DatabaseSync(to)
    assert.equal(handle.prepare('SELECT count(*) AS n FROM events').get()?.n, 1)
    handle.close()
  } finally {
    process.umask(previous)
  }
})

test('backup over an existing file, or inside a transaction, is a Result and not a throw', async () => {
  using base = tempBase()
  const db = await open(base.dir)
  const to = join(base.dir, 'backups', 'jobs.db')
  assert.ok(db.backup(to).ok)
  assert.equal(db.backup(to).ok, false)
  const inside = db.tx(() => db.backup(join(base.dir, 'backups', 'other.db')))
  assert.equal(inside.ok, false)
  db.close()
})

test('close is idempotent, and a transaction after close is a Result', async () => {
  using base = tempBase()
  const db = await open(base.dir)
  db.close()
  db.close()
  assert.equal(db.tx(() => ok(1)).ok, false)
})
