import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { moduleStateDir, statePaths } from '@factotum/kernel'
import { jobsCommand } from './jobs-command.ts'

const NOW = new Date('2026-11-13T10:00:00.000Z')
const now = () => NOW

function capture() {
  const lines: string[] = []
  return { lines, out: (line: string) => void lines.push(line) }
}

async function freshHome(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'factotum-jobs-cmd-'))
}

function dbFile(home: string): string {
  return join(moduleStateDir(statePaths('dev', home), 'jobs'), 'jobs.db')
}

/** Reads the base the command wrote, straight from SQLite: the test does not trust the engine to report on itself. */
function inspect<T>(home: string, read: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(dbFile(home))
  try {
    return read(db)
  } finally {
    db.close()
  }
}

/** The daemon in the middle of a send: an application `sending` with its `sends` row `sending`. */
function sendInFlight(home: string): void {
  const db = new DatabaseSync(dbFile(home))
  const at = NOW.toISOString()
  try {
    db.prepare(`INSERT INTO companies (id, name, name_key, created_at, updated_at) VALUES ('c-busy', 'Acme', 'acme', ?, ?)`).run(at, at)
    db.prepare(
      `INSERT INTO opportunities (id, company_id, kind, title, dedupe_key, source) VALUES ('o-busy', 'c-busy', 'outreach', 'Nurse', 'busy', 'seed')`,
    ).run()
    db.prepare(
      `INSERT INTO applications (id, opportunity_id, company_id, channel, state, created_at, updated_at) VALUES ('busy', 'o-busy', 'c-busy', 'email', 'sending', ?, ?)`,
    ).run(at, at)
    db.prepare(`INSERT INTO sends (application_id, kind, channel, state, at) VALUES ('busy', 'initial', 'email', 'sending', ?)`).run(at)
  } finally {
    db.close()
  }
}

async function createTest(home: string, out: (line: string) => void): Promise<number> {
  return await jobsCommand({ env: 'dev', argv: ['test-application', '--to', 'owner@example.test'], home, out, now })
}

test('test-application --to creates the test application in generating, its CV queued in work, and prints its id', async () => {
  const home = await freshHome()
  const { lines, out } = capture()

  const code = await createTest(home, out)

  assert.equal(code, 0)
  const app = inspect(home, (db) => db.prepare(`SELECT id, state, test FROM applications`).get() as { id: string; state: string; test: number })
  assert.equal(app.state, 'generating')
  assert.equal(app.test, 1)
  const work = inspect(home, (db) => db.prepare(`SELECT kind, ref FROM work`).all() as { kind: string; ref: string }[])
  assert.deepEqual(
    work.map((w) => [w.kind, w.ref]),
    [['cv', app.id]],
  )
  assert.match(lines.join('\n'), new RegExp(app.id))
})

test('an address that is not one exits 1 with the reason and writes no application', async () => {
  const home = await freshHome()
  const { lines, out } = capture()

  const code = await jobsCommand({ env: 'dev', argv: ['test-application', '--to', 'not an address'], home, out, now })

  assert.equal(code, 1)
  assert.match(lines.join('\n'), /to must be one email address/)
  assert.equal(inspect(home, (db) => (db.prepare(`SELECT count(*) AS n FROM applications`).get() as { n: number }).n), 0)
})

test('a second test application while the first is open exits 1 (conflict) and names the way out', async () => {
  const home = await freshHome()
  await createTest(home, () => undefined)
  const { lines, out } = capture()

  const code = await createTest(home, out)

  assert.equal(code, 1)
  assert.match(lines.join('\n'), /still open/)
})

test('--close <id> --reason <text> closes it; another can then be made', async () => {
  const home = await freshHome()
  await createTest(home, () => undefined)
  const id = inspect(home, (db) => (db.prepare(`SELECT id FROM applications`).get() as { id: string }).id)
  const { out } = capture()

  const code = await jobsCommand({ env: 'dev', argv: ['test-application', '--close', id, '--reason', 'test done'], home, out, now })

  assert.equal(code, 0)
  assert.equal(inspect(home, (db) => (db.prepare(`SELECT state FROM applications WHERE id = ?`).get(id) as { state: string }).state), 'closed')
  assert.equal(await createTest(home, () => undefined), 0)
})

test('--close of an id the base does not have exits 1 (not-found)', async () => {
  const home = await freshHome()
  await createTest(home, () => undefined)
  const { lines, out } = capture()

  const code = await jobsCommand({ env: 'dev', argv: ['test-application', '--close', 'nope', '--reason', 'x'], home, out, now })

  assert.equal(code, 1)
  assert.match(lines.join('\n'), /no such application/)
})

test('--close without --reason exits 2 with the usage, and closes nothing', async () => {
  const home = await freshHome()
  await createTest(home, () => undefined)
  const id = inspect(home, (db) => (db.prepare(`SELECT id FROM applications`).get() as { id: string }).id)
  const { lines, out } = capture()

  const code = await jobsCommand({ env: 'dev', argv: ['test-application', '--close', id], home, out, now })

  assert.equal(code, 2)
  assert.match(lines.join('\n'), /usage: factotum jobs test-application/)
  assert.equal(inspect(home, (db) => (db.prepare(`SELECT state FROM applications WHERE id = ?`).get(id) as { state: string }).state), 'generating')
})

test('with a send in flight in the base (the daemon mid-send), the command leaves it sending, not send-unknown', async () => {
  const home = await freshHome()
  await createTest(home, () => undefined) // creates the base
  const id = inspect(home, (db) => (db.prepare(`SELECT id FROM applications`).get() as { id: string }).id)
  sendInFlight(home)

  assert.equal(await jobsCommand({ env: 'dev', argv: ['test-application', '--close', id, '--reason', 'again'], home, out: () => undefined, now }), 0)
  assert.equal(await createTest(home, () => undefined), 0)

  const after = inspect(home, (db) => ({
    send: (db.prepare(`SELECT state FROM sends WHERE application_id = 'busy'`).get() as { state: string }).state,
    app: (db.prepare(`SELECT state FROM applications WHERE id = 'busy'`).get() as { state: string }).state,
  }))
  assert.deepEqual(after, { send: 'sending', app: 'sending' })
})

test('bad arguments exit 2 with the usage: no subcommand, an unknown one, neither --to nor --close, both', async () => {
  const home = await freshHome()
  for (const argv of [[], ['nope'], ['test-application'], ['test-application', '--to'], ['test-application', '--to', 'a@b.test', '--close', 'x', '--reason', 'y']]) {
    const { lines, out } = capture()
    const code = await jobsCommand({ env: 'dev', argv, home, out, now })
    assert.equal(code, 2, JSON.stringify(argv))
    assert.match(lines.join('\n'), /usage: factotum jobs test-application/)
  }
})
