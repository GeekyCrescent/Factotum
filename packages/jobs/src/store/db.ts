/**
 * Opening `jobs.db`: load the driver, check, migrate, lock the modes down (design D2).
 *
 * `node:sqlite` IS LOADED BY A DYNAMIC `import()` HERE AND NOWHERE ELSE (v4, N4). A static import
 * would break the loading of the whole daemon on a Node without it; this way only `jobs` goes off,
 * with the reason (requirements §6). B7 greps for a static one. Types come from `typeof import(…)`.
 *
 * NOTHING HERE THROWS. `openDb`, `tx` and `backup` answer with a `Result`; a store that is newer,
 * unreadable or damaged is never touched — it is copied to `jobs.db.bad-<date>` and refused. The copy
 * is taken ONCE per state of the file (a store refused at every restart does not fill the disk), and a
 * copy that cannot be written is said in the reason, not thrown.
 *
 * `DatabaseSync` creates its files with the umask of the process, so every open ends with a
 * `chmod 0o600` of `jobs.db`, `-wal` and `-shm`, and every copy gets the same (R8).
 *
 * `openDb` only opens, migrates and checks: the startup write (`sending → send-unknown`…) is the
 * daemon's, in `repo.ts`, never the CLI's (design D3, «La postulación de prueba»).
 */

import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fail, ok, type Result } from '../types.ts'
import { MIGRATIONS } from './schema.sql.ts'

type Sqlite = typeof import('node:sqlite')
type Handle = InstanceType<Sqlite['DatabaseSync']>
type Statement = ReturnType<Handle['prepare']>

export type SqlValue = null | number | bigint | string | Uint8Array

/** The query handle every function of `repo.ts` takes. Rows come back frozen, as plain objects. */
export interface Queries {
  readonly run: (sql: string, ...params: SqlValue[]) => { readonly changes: number }
  readonly get: <R = Readonly<Record<string, SqlValue>>>(sql: string, ...params: SqlValue[]) => R | undefined
  readonly all: <R = Readonly<Record<string, SqlValue>>>(sql: string, ...params: SqlValue[]) => readonly R[]
}

export interface Db {
  /** BEGIN IMMEDIATE … COMMIT; `fn` gives a Result and a `!ok` ROLLs BACK. Never throws. */
  readonly tx: <T>(fn: (q: Queries) => Result<T>) => Result<T>
  readonly read: <T>(fn: (q: Queries) => T) => T
  /** `VACUUM INTO`, then `chmod 0o600` before the copy counts. */
  readonly backup: (to: string) => Result<void>
  readonly close: () => void
}

export interface OpenOptions {
  /** `<stateDir>`; created `0700`. */
  readonly dir: string
  readonly now: () => Date
  /** The seam for a Node without `node:sqlite`. */
  readonly load?: () => Promise<Sqlite>
  /** The seam for a test migration (a v2 on top of v1). */
  readonly migrations?: readonly string[]
}

export const DB_FILE = 'jobs.db'
const BUSY_TIMEOUT_MS = 2000
const MIN_NODE = '22.13'

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

function lockDown(path: string): void {
  if (existsSync(path)) chmodSync(path, 0o600)
}

const companions = (file: string): readonly string[] => [file, `${file}-wal`, `${file}-shm`]

const codeOf = (error: unknown): string =>
  typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : messageOf(error)

const BAD_PREFIX = `${DB_FILE}.bad-`
const WAL = '-wal'

/** The size of a file, or null when there is none. */
const sizeOf = (path: string): number | null => (existsSync(path) ? statSync(path).size : null)

/**
 * A copy already taken of the store AS IT IS NOW: same size (and the same for its WAL), written after
 * the store last changed. A store refused at every start (a newer schema, a damaged page) is copied
 * once, not once per restart — a restart loop would fill the disk (D2 asks for the copy, not for many).
 */
function existingCopy(file: string): string | undefined {
  const store = statSync(file)
  const changedAt = Math.max(store.mtimeMs, existsSync(file + WAL) ? statSync(file + WAL).mtimeMs : 0)
  const walSize = sizeOf(file + WAL)
  const dir = dirname(file)
  return readdirSync(dir)
    .filter((name) => name.startsWith(BAD_PREFIX) && !name.endsWith(WAL))
    .find((name) => {
      const copy = statSync(join(dir, name))
      return copy.isFile() && copy.size === store.size && copy.mtimeMs >= changedAt && sizeOf(join(dir, name + WAL)) === walSize
    })
}

/** Copies the store (and its WAL) aside, untouched — or finds the copy already taken — and refuses. */
function quarantine<T>(file: string, now: () => Date, reason: string): Result<T> {
  try {
    if (!existsSync(file)) return fail('module-error', reason)
    const known = existingCopy(file)
    if (known !== undefined) return fail('module-error', `${reason}; a copy is at ${known}`)
    const name = `${BAD_PREFIX}${now().toISOString().replaceAll(':', '-')}`
    const bad = join(dirname(file), name)
    for (const [from, to] of [
      [file, bad],
      [file + WAL, bad + WAL],
    ] as const) {
      if (!existsSync(from)) continue
      copyFileSync(from, to)
      chmodSync(to, 0o600)
    }
    return fail('module-error', `${reason}; a copy is at ${name}`)
  } catch (error) {
    return fail('module-error', `${reason}; it could not be copied aside (${codeOf(error)}); it was left as it is`)
  }
}

async function loadSqlite(load: () => Promise<Sqlite>): Promise<Result<Sqlite>> {
  try {
    return ok(await load())
  } catch (error) {
    // Usually an old Node, but not always (a broken install, a sandbox): the real error goes along.
    return fail('module-error', `node:sqlite is not available in Node ${process.versions.node}; jobs needs >= ${MIN_NODE} (${messageOf(error)})`)
  }
}

/** SQLite's primary code for «another connection holds the lock» (the extended codes share the low byte). */
const SQLITE_BUSY = 5
const PRIMARY_CODE_MASK = 0xff

/** Still locked after `busy_timeout`: someone else holds the file, nothing says it is damaged. */
const isBusy = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'errcode' in error && (Number(error.errcode) & PRIMARY_CODE_MASK) === SQLITE_BUSY

type Inspection =
  | { readonly kind: 'ok'; readonly version: number }
  /** Not ours to touch: copied aside and refused. */
  | { readonly kind: 'bad'; readonly reason: string }
  /** Locked past the wait: refused, with no copy (the next start tries again). */
  | { readonly kind: 'busy'; readonly reason: string }

function unreadable(error: unknown): Inspection {
  return isBusy(error)
    ? { kind: 'busy', reason: `jobs.db is locked by another process past ${BUSY_TIMEOUT_MS} ms: ${messageOf(error)}` }
    : { kind: 'bad', reason: `jobs.db does not open: ${messageOf(error)}` }
}

/** `integrity_check` can list a hundred problems: the reason keeps the start of the list. */
const VERDICT_MAX = 200
const truncated = (text: string): string => (text.length <= VERDICT_MAX ? text : `${text.slice(0, VERDICT_MAX - 1)}…`)

/** The version, then `integrity_check`: either one failing means the store is not ours to touch. */
function inspect(handle: Handle, target: number): Inspection {
  let version: number
  try {
    version = Number(handle.prepare('PRAGMA user_version').get()?.user_version ?? 0)
  } catch (error) {
    return unreadable(error)
  }
  if (version > target) return { kind: 'bad', reason: `jobs.db schema version ${version} is newer than this code's ${target}` }
  try {
    const rows = handle.prepare('PRAGMA integrity_check').all()
    const verdict = rows.map((row) => String(row.integrity_check)).join('; ')
    if (verdict !== 'ok') return { kind: 'bad', reason: `jobs.db fails integrity_check: ${truncated(verdict)}` }
  } catch (error) {
    return unreadable(error)
  }
  return { kind: 'ok', version }
}

/** Undoes an open transaction; null when done (or nothing to undo), else what went wrong. Never throws. */
function rollback(handle: Handle): string | null {
  try {
    if (handle.isOpen && handle.isTransaction) handle.exec('ROLLBACK')
    return null
  } catch (error) {
    return `the rollback failed too: ${messageOf(error)}`
  }
}

function migrate(handle: Handle, from: number, migrations: readonly string[]): Result<void> {
  for (let version = from; version < migrations.length; version += 1) {
    try {
      handle.exec('BEGIN IMMEDIATE')
      handle.exec(migrations[version] ?? '')
      handle.exec(`PRAGMA user_version = ${version + 1}`)
      handle.exec('COMMIT')
    } catch (error) {
      const rolledBack = rollback(handle)
      const tail = rolledBack === null ? '' : `; ${rolledBack}`
      return fail('module-error', `jobs.db migration to v${version + 1} failed: ${messageOf(error)}${tail}`)
    }
  }
  return ok(undefined)
}

function queriesOver(handle: Handle): Queries {
  const cache = new Map<string, Statement>()
  const prepared = (sql: string): Statement => {
    const known = cache.get(sql)
    if (known !== undefined) return known
    const statement = handle.prepare(sql)
    cache.set(sql, statement)
    return statement
  }
  const frozen = <R>(row: object): R => Object.freeze({ ...row }) as R
  return {
    run: (sql, ...params) => ({ changes: Number(prepared(sql).run(...params).changes) }),
    get: <R>(sql: string, ...params: SqlValue[]) => {
      const row = prepared(sql).get(...params)
      return row === undefined ? undefined : frozen<R>(row)
    },
    all: <R>(sql: string, ...params: SqlValue[]) => Object.freeze(prepared(sql).all(...params).map((row) => frozen<R>(row))),
  }
}

function dbOver(handle: Handle): Db {
  const queries = queriesOver(handle)
  let inTx = false
  let closed = false
  return {
    tx: (fn) => {
      if (closed) return fail('module-error', 'jobs.db is closed')
      if (inTx) return fail('module-error', 'a transaction is already open')
      // A transaction left open by a rollback that failed: undo it now, or refuse without writing.
      const leftover = rollback(handle)
      if (leftover !== null) return fail('module-error', `a previous transaction is still open; ${leftover}`)
      inTx = true
      try {
        handle.exec('BEGIN IMMEDIATE')
        const result = fn(queries)
        if (result.ok) {
          handle.exec('COMMIT')
          return result
        }
        const rolledBack = rollback(handle)
        return rolledBack === null ? result : { ok: false, error: { ...result.error, reason: `${result.error.reason}; ${rolledBack}` } }
      } catch (error) {
        // The body threw (a trigger, a constraint, a bug): undo whatever it wrote, and answer. The
        // error travels whole as `cause`, so the caller's log keeps its stack (CLAUDE.md §5: a fault
        // inside one module degrades that module; precedent: tasks' board store answers the same way).
        const rolledBack = rollback(handle)
        const reason = rolledBack === null ? messageOf(error) : `${messageOf(error)}; ${rolledBack}`
        return { ok: false, error: { code: 'module-error', reason, cause: error } }
      } finally {
        inTx = false
      }
    },
    read: (fn) => fn(queries),
    backup: (to) => {
      if (inTx) return fail('module-error', 'a backup cannot run inside a transaction')
      try {
        mkdirSync(dirname(to), { recursive: true, mode: 0o700 })
        chmodSync(dirname(to), 0o700)
        handle.prepare('VACUUM INTO ?').run(to)
        chmodSync(to, 0o600)
        return ok(undefined)
      } catch (error) {
        return fail('module-error', `backup failed: ${messageOf(error)}`)
      }
    },
    close: () => {
      if (closed) return
      closed = true
      handle.close()
    },
  }
}

/**
 * The schema version of `<dir>/jobs.db`, opened READ ONLY: null when there is no file. Creates,
 * migrates and quarantines nothing — the CLI's check before `openDb`, so a CLI of another version
 * never moves the daemon's store under it (review 1a).
 */
export async function storeVersion(dir: string, load: () => Promise<Sqlite> = () => import('node:sqlite')): Promise<Result<number | null>> {
  const file = join(dir, DB_FILE)
  if (!existsSync(file)) return ok(null)
  const sqlite = await loadSqlite(load)
  if (!sqlite.ok) return sqlite
  try {
    const handle = new sqlite.value.DatabaseSync(file, { readOnly: true })
    try {
      handle.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`)
      return ok(Number(handle.prepare('PRAGMA user_version').get()?.user_version ?? 0))
    } finally {
      handle.close()
    }
  } catch (error) {
    return fail('module-error', `jobs.db does not open: ${messageOf(error)}`)
  }
}

export async function openDb(options: OpenOptions): Promise<Result<Db>> {
  const migrations = options.migrations ?? MIGRATIONS
  const sqlite = await loadSqlite(options.load ?? (() => import('node:sqlite')))
  if (!sqlite.ok) return sqlite
  try {
    mkdirSync(options.dir, { recursive: true, mode: 0o700 })
    chmodSync(options.dir, 0o700)
  } catch (error) {
    return fail('module-error', `the jobs state folder could not be prepared (${codeOf(error)})`)
  }
  const file = join(options.dir, DB_FILE)

  let handle: Handle
  try {
    handle = new sqlite.value.DatabaseSync(file)
  } catch (error) {
    return quarantine(file, options.now, `jobs.db does not open: ${messageOf(error)}`)
  }
  // The CLI and the daemon open the same file: the wait goes on BEFORE the first read, or a lock held
  // for a moment reads as damage. Setting it touches no page, so it cannot be busy itself.
  try {
    handle.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`)
  } catch (error) {
    handle.close()
    return fail('module-error', `jobs.db pragmas failed: ${messageOf(error)}`)
  }
  const inspected = inspect(handle, migrations.length)
  if (inspected.kind !== 'ok') {
    handle.close()
    return inspected.kind === 'busy' ? fail('module-error', inspected.reason) : quarantine(file, options.now, inspected.reason)
  }
  try {
    handle.exec('PRAGMA journal_mode = WAL')
    handle.exec('PRAGMA foreign_keys = ON')
  } catch (error) {
    handle.close()
    return fail('module-error', `jobs.db pragmas failed: ${messageOf(error)}`)
  }
  const migrated = migrate(handle, inspected.version, migrations)
  if (!migrated.ok) {
    handle.close()
    return migrated
  }
  try {
    for (const path of companions(file)) lockDown(path)
  } catch (error) {
    handle.close()
    return fail('module-error', `jobs.db could not be made 0600 (${codeOf(error)})`)
  }
  return ok(dbOver(handle))
}
