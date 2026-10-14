import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { board, captureLog, ctx, NOW, task, ZONE } from '../test-support.ts'
import type { Board, Task } from '../types.ts'
import { createTask, patchTask } from './ops.ts'
import { BOARD_FILE, openBoardStore, type BoardStore } from './store.ts'

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'tasks-store-'))
}

async function open(dir: string, now: Date = NOW): Promise<BoardStore> {
  const opened = await openBoardStore({ dir, timeZone: ZONE, now, log: captureLog() })
  if (!opened.ok) throw new Error(`expected a store, got: ${opened.reason}`)
  return opened.store
}

async function onDisk(dir: string): Promise<Board> {
  return JSON.parse(await readFile(join(dir, BOARD_FILE), 'utf8')) as Board
}

test('a missing board.json is created empty, with the current cycle open, 0600 in a 0700 folder', async (t) => {
  const root = await tempDir()
  t.after(() => rm(root, { recursive: true, force: true }))
  const dir = join(root, 'state')
  const store = await open(dir)
  assert.equal(store.current().openCycle, '2026-W42')
  assert.equal(store.current().tasks.length, 0)
  assert.equal((await stat(dir)).mode & 0o777, 0o700)
  assert.equal((await stat(join(dir, BOARD_FILE))).mode & 0o777, 0o600)
  assert.deepEqual(await onDisk(dir), store.current())
})

test('a folder left open by an earlier build is tightened to 0700', async (t) => {
  const dir = await tempDir()
  t.after(() => rm(dir, { recursive: true, force: true }))
  await chmod(dir, 0o755)
  await open(dir)
  assert.equal((await stat(dir)).mode & 0o777, 0o700)
})

test('a change is written, and reopening gives the same board byte for byte (criterion 5)', async (t) => {
  const dir = await tempDir()
  t.after(() => rm(dir, { recursive: true, force: true }))
  const store = await open(dir)
  const result = await store.change((b) => createTask(b, { title: 'Essay', status: 'todo', labels: ['uni'] }, ctx()))
  assert.ok(result.ok)
  const before = await readFile(join(dir, BOARD_FILE), 'utf8')
  await store.idle()
  const again = await open(dir)
  assert.deepEqual(again.current(), store.current())
  assert.equal(await readFile(join(dir, BOARD_FILE), 'utf8'), before, 'opening a clean board does not write it')
})

test('50 concurrent changes: none is lost (criterion 6)', async (t) => {
  const dir = await tempDir()
  t.after(() => rm(dir, { recursive: true, force: true }))
  const store = await open(dir)
  const make = ctx()
  const results = await Promise.all(
    Array.from({ length: 50 }, (_, i) => store.change((b) => createTask(b, { title: `card ${i}`, status: 'backlog' }, make))),
  )
  assert.ok(results.every((r) => r.ok))
  assert.equal(store.current().tasks.length, 50)
  assert.equal((await onDisk(dir)).tasks.length, 50)
  assert.equal(new Set(store.current().tasks.map((x) => x.order)).size, 50)
})

test('an op that refuses leaves memory and disk as they were, and writes nothing', async (t) => {
  const dir = await tempDir()
  t.after(() => rm(dir, { recursive: true, force: true }))
  const store = await open(dir)
  const before = await readFile(join(dir, BOARD_FILE), 'utf8')
  const result = await store.change((b) => patchTask(b, 'nope', { title: 'x' }, ctx()))
  assert.equal(result.ok, false)
  assert.equal(await readFile(join(dir, BOARD_FILE), 'utf8'), before)
})

test('a write that fails leaves memory and disk the same, and answers module-error', async (t) => {
  const dir = await tempDir()
  t.after(async () => {
    await chmod(dir, 0o700)
    await rm(dir, { recursive: true, force: true })
  })
  const store = await open(dir)
  const before = await readFile(join(dir, BOARD_FILE), 'utf8')
  const memory = store.current()
  await chmod(dir, 0o500) // the temporary file cannot be created
  const result = await store.change((b) => createTask(b, { title: 'x', status: 'backlog' }, ctx()))
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.error.code, 'module-error')
  assert.equal(store.current(), memory)
  await chmod(dir, 0o700)
  assert.equal(await readFile(join(dir, BOARD_FILE), 'utf8'), before)
  // And the queue goes on after a failure.
  assert.ok((await store.change((b) => createTask(b, { title: 'y', status: 'backlog' }, ctx()))).ok)
})

test('an op that throws is a module-error, and the queue goes on', async (t) => {
  const dir = await tempDir()
  t.after(() => rm(dir, { recursive: true, force: true }))
  const store = await open(dir)
  const result = await store.change(() => {
    throw new Error('boom')
  })
  assert.equal(result.ok, false)
  assert.ok((await store.change((b) => createTask(b, { title: 'y', status: 'backlog' }, ctx()))).ok)
})

async function seeded(dir: string, contents: string): Promise<void> {
  await writeFile(join(dir, BOARD_FILE), contents, { mode: 0o600 })
}

for (const [name, contents] of [
  ['text that is not JSON', '{"version": 1, "tasks": ['],
  ['JSON that is not a board', JSON.stringify({ version: 1, tasks: 'none' })],
  ['a board with a field nobody knows', JSON.stringify({ ...board(), colour: 'red' })],
  ['a card with a cycle id without padding', JSON.stringify(board([task({ id: 'a', status: 'todo', cycle: '2026-W9' })]))],
] as const) {
  test(`a damaged board.json (${name}) is NOT overwritten, and a copy goes to .bad-<date> (criterion 3)`, async (t) => {
    const dir = await tempDir()
    t.after(() => rm(dir, { recursive: true, force: true }))
    await seeded(dir, contents)
    const log = captureLog()
    const opened = await openBoardStore({ dir, timeZone: ZONE, now: NOW, log })
    assert.equal(opened.ok, false)
    if (!opened.ok) {
      assert.match(opened.reason, /board\.json/)
      assert.ok(!opened.reason.includes('red'), 'the reason never carries a value')
    }
    assert.equal(await readFile(join(dir, BOARD_FILE), 'utf8'), contents)
    const files = await readdir(dir)
    const bad = files.find((f) => f.startsWith(`${BOARD_FILE}.bad-`))
    assert.ok(bad !== undefined, `a .bad copy among ${files.join(', ')}`)
    assert.ok(!bad.includes(':'), 'the date in the name carries no colon')
    assert.equal(await readFile(join(dir, bad), 'utf8'), contents)
  })
}

test('cards whose parse was pending start as failed, in one write (criterion 23c)', async (t) => {
  const dir = await tempDir()
  t.after(() => rm(dir, { recursive: true, force: true }))
  const pending = (id: string): Task => task({ id, status: 'triage', source: { kind: 'capture', raw: 'x', parse: 'pending' } })
  await seeded(dir, JSON.stringify(board([pending('a'), pending('b'), task({ id: 'c' })])))
  const store = await open(dir)
  const parses = store.current().tasks.map((x) => (x.source.kind === 'capture' ? x.source.parse : 'owner'))
  assert.deepEqual(parses, ['failed', 'failed', 'owner'])
  assert.deepEqual(await onDisk(dir), store.current())
})

test('a board written in another zone is kept, with a warning and the zone of the config', async (t) => {
  const dir = await tempDir()
  t.after(() => rm(dir, { recursive: true, force: true }))
  await seeded(dir, JSON.stringify(board([], { timeZone: 'Europe/Madrid' })))
  const log = captureLog()
  const opened = await openBoardStore({ dir, timeZone: ZONE, now: NOW, log })
  assert.ok(opened.ok)
  if (opened.ok) assert.equal(opened.store.current().timeZone, ZONE)
  assert.ok(log.lines.some((line) => line.startsWith('warn') && line.includes('Europe/Madrid')))
  assert.equal((await onDisk(dir)).timeZone, ZONE)
})

test('a board.json that cannot be read for another reason is an error, not an empty board', async (t) => {
  const dir = await tempDir()
  t.after(async () => {
    await chmod(join(dir, BOARD_FILE), 0o600)
    await rm(dir, { recursive: true, force: true })
  })
  await seeded(dir, JSON.stringify(board()))
  await chmod(join(dir, BOARD_FILE), 0o000)
  const opened = await openBoardStore({ dir, timeZone: ZONE, now: NOW, log: captureLog() })
  assert.equal(opened.ok, false)
})
