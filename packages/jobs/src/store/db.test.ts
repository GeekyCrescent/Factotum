import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
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

test('a throw inside the body rolls back and becomes a Result that keeps the error as its cause', async () => {
  using base = tempBase()
  const db = await open(base.dir)
  const boom = new TypeError('boom')
  const result = db.tx((q) => {
    q.run("INSERT INTO meta (key, value) VALUES ('k', 'v')")
    throw boom
  })
  assert.deepEqual(result, { ok: false, error: { code: 'module-error', reason: 'boom', cause: boom } })
  if (!result.ok) assert.equal(result.error.cause, boom, 'the same error, with its stack')
  assert.equal(db.read((q) => q.get("SELECT value FROM meta WHERE key = 'k'")), undefined)
  db.close()
})

/** The real driver, with a `ROLLBACK` that fails while `failRollback.on` is set. */
async function rollbackFailing(): Promise<{ readonly load: () => Promise<typeof import('node:sqlite')>; readonly failRollback: { on: boolean } }> {
  const real = await import('node:sqlite')
  const failRollback = { on: false }
  class DatabaseSync extends real.DatabaseSync {
    override exec(sql: string): void {
      if (failRollback.on && sql === 'ROLLBACK') throw new Error('disk I/O error')
      super.exec(sql)
    }
  }
  return { load: () => Promise.resolve({ ...real, DatabaseSync }), failRollback }
}

test('a ROLLBACK that fails after a throw is still a Result naming both, never a throw', async () => {
  using base = tempBase()
  const { load, failRollback } = await rollbackFailing()
  const opened = await openDb({ dir: base.dir, now: manualClock(NOW).now, load })
  assert.ok(opened.ok)
  if (!opened.ok) return
  failRollback.on = true
  const result = opened.value.tx(() => {
    throw new Error('boom')
  })
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.error.reason, 'boom; the rollback failed too: disk I/O error')
  // The transaction it left open is undone before the next one, or the next one refuses.
  const blocked = opened.value.tx(() => ok(1))
  assert.equal(blocked.ok, false)
  if (!blocked.ok) assert.equal(blocked.error.reason, 'a previous transaction is still open; the rollback failed too: disk I/O error')
  failRollback.on = false
  assert.deepEqual(opened.value.tx(() => ok(1)), { ok: true, value: 1 })
  failRollback.on = true
  const refused = opened.value.tx(() => fail('conflict', 'no'))
  assert.equal(refused.ok, false)
  if (!refused.ok) assert.deepEqual(refused.error, { code: 'conflict', reason: 'no; the rollback failed too: disk I/O error' })
  failRollback.on = false
  opened.value.close()
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

interface HeldLock {
  /** Lets go now, and resolves when the holder is gone. */
  readonly release: () => Promise<void>
}

/**
 * A second process (the CLI beside the daemon) holding the file: a worker thread takes an EXCLUSIVE
 * lock and keeps it until `holdMs` passes or `release` is called. Resolves once the lock is held.
 */
async function holdLock(file: string, holdMs: number): Promise<HeldLock> {
  const signal = new Int32Array(new SharedArrayBuffer(4))
  const source = `
    const { workerData, parentPort } = require('node:worker_threads')
    const { DatabaseSync } = require('node:sqlite')
    const handle = new DatabaseSync(workerData.file)
    handle.exec('PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE; INSERT INTO meta (key, value) VALUES (\\'lock\\', \\'x\\');')
    parentPort.postMessage('locked')
    Atomics.wait(workerData.signal, 0, 0, workerData.holdMs)
    handle.exec('ROLLBACK')
    handle.close()
  `
  const worker = new Worker(source, { eval: true, workerData: { file, holdMs, signal } })
  const exited = new Promise<void>((resolve) => worker.once('exit', () => resolve()))
  await new Promise<void>((resolve, reject) => {
    worker.once('message', () => resolve())
    worker.once('error', reject)
  })
  return {
    release: () => {
      Atomics.store(signal, 0, 1)
      Atomics.notify(signal, 0)
      return exited
    },
  }
}

test('a store busy for a moment (another process holds it) is waited for, not copied aside as damaged', async () => {
  using base = tempBase()
  ;(await open(base.dir)).close()
  const lock = await holdLock(join(base.dir, 'jobs.db'), 300)
  const opened = await openDb({ dir: base.dir, now: manualClock(NOW).now })
  await lock.release()
  assert.ok(opened.ok, opened.ok ? '' : opened.error.reason)
  opened.value.close()
  assert.deepEqual(readdirSync(base.dir).filter((name) => name.includes('.bad-')), [])
})

test('a store still locked past busy_timeout is refused with the reason, and NOT copied aside', async () => {
  using base = tempBase()
  ;(await open(base.dir)).close()
  const lock = await holdLock(join(base.dir, 'jobs.db'), 30_000)
  const opened = await openDb({ dir: base.dir, now: manualClock(NOW).now })
  await lock.release()
  assert.equal(opened.ok, false)
  if (!opened.ok) assert.match(opened.error.reason, /locked by another process past 2000 ms/)
  assert.deepEqual(readdirSync(base.dir).filter((name) => name.includes('.bad-')), [])
})

test('a v99 store refused at every start is copied aside ONCE: a restart loop does not fill the disk', async () => {
  using base = tempBase()
  await rawDb(join(base.dir, 'jobs.db'), 99)
  const reasons: string[] = []
  for (const at of [NOW, '2026-11-14T03:05:05.000Z', '2026-11-14T03:06:05.000Z']) {
    const opened = await openDb({ dir: base.dir, now: manualClock(at).now })
    assert.equal(opened.ok, false)
    if (!opened.ok) reasons.push(opened.error.reason)
  }
  assert.deepEqual(readdirSync(base.dir).filter((name) => name.startsWith('jobs.db.bad-')), ['jobs.db.bad-2026-11-14T03-04-05.000Z'])
  for (const reason of reasons) assert.match(reason, /newer than this code's 1; a copy is at jobs\.db\.bad-2026-11-14T03-04-05\.000Z/)
})

test('a store that changed since its last copy is copied again', async () => {
  using base = tempBase()
  const file = join(base.dir, 'jobs.db')
  await rawDb(file, 99)
  assert.equal((await openDb({ dir: base.dir, now: manualClock(NOW).now })).ok, false)
  await rawDb(file, 99) // one more row: another size
  assert.equal((await openDb({ dir: base.dir, now: manualClock('2026-11-14T03:05:05.000Z').now })).ok, false)
  assert.equal(readdirSync(base.dir).filter((name) => name.startsWith('jobs.db.bad-')).length, 2)
})

test('a copy aside that cannot be written is a Result with both reasons, never a throw', async () => {
  using base = tempBase()
  await rawDb(join(base.dir, 'jobs.db'), 99)
  mkdirSync(join(base.dir, 'jobs.db.bad-2026-11-14T03-04-05.000Z')) // the copy's path is taken by a folder
  const opened = await openDb({ dir: base.dir, now: manualClock(NOW).now })
  assert.equal(opened.ok, false)
  if (!opened.ok) {
    assert.equal(opened.error.code, 'module-error')
    assert.match(opened.error.reason, /newer than this code's 1; it could not be copied aside \(E[A-Z]+\); it was left as it is/)
  }
})

test('a state folder that cannot be made is a Result, never a throw', async () => {
  using base = tempBase()
  writeFileSync(join(base.dir, 'file'), 'x')
  const opened = await openDb({ dir: join(base.dir, 'file', 'state'), now: manualClock(NOW).now })
  assert.equal(opened.ok, false)
  if (!opened.ok) assert.match(opened.error.reason, /the jobs state folder could not be prepared \(ENOTDIR\)/)
})

test('the integrity_check verdict is in the reason, cut to a readable length', async () => {
  using base = tempBase()
  const file = join(base.dir, 'jobs.db')
  const db = await open(base.dir)
  db.tx((q) => {
    q.run('CREATE INDEX meta_value ON meta (value)')
    for (let i = 0; i < 50; i += 1) q.run('INSERT INTO meta (key, value) VALUES (?, ?)', `k${i}`, `v${i}`)
    return ok(undefined)
  })
  db.close()
  // Drift the index from its table without touching a page header: integrity_check names the rows.
  const { DatabaseSync } = await import('node:sqlite')
  const raw = new DatabaseSync(file, { defensive: false } as ConstructorParameters<typeof DatabaseSync>[1])
  raw.exec("PRAGMA writable_schema = ON; UPDATE sqlite_master SET sql = 'CREATE INDEX meta_value ON meta (key)' WHERE name = 'meta_value'; PRAGMA writable_schema = OFF;")
  raw.close()
  const opened = await openDb({ dir: base.dir, now: manualClock(NOW).now })
  assert.equal(opened.ok, false)
  if (!opened.ok) {
    const verdict = /fails integrity_check: (.*); a copy is at/.exec(opened.error.reason)?.[1] ?? ''
    assert.match(verdict, /meta_value/)
    assert.ok(verdict.length <= 201, `verdict of ${verdict.length} chars`)
  }
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
  if (!opened.ok) assert.match(opened.error.reason, /fails integrity_check: \S|does not open: \S/)
  assert.ok(existsSync(join(base.dir, 'jobs.db.bad-2026-11-14T03-04-05.000Z')))
})

test('a Node without node:sqlite gives a Result with the reason and does not throw (N4)', async () => {
  using base = tempBase()
  const opened = await openDb({ dir: base.dir, now: manualClock(NOW).now, load: () => Promise.reject(new Error('No such built-in module: node:sqlite')) })
  assert.equal(opened.ok, false)
  if (!opened.ok) {
    assert.equal(opened.error.code, 'module-error')
    assert.equal(opened.error.reason, `node:sqlite is not available in Node ${process.versions.node}; jobs needs >= 22.13 (No such built-in module: node:sqlite)`)
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
