import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acceptTask, patchTask } from '../board/ops.ts'
import { openBoardStore, type BoardStore } from '../board/store.ts'
import { captureLog, counter, eventually, NOW, ZONE } from '../test-support.ts'
import type { Board, Result, Task } from '../types.ts'
import { createCapturer, MAX_PARALLEL_PARSES, type CaptureInput, type Capturer } from './capture.ts'
import type { RunResult } from './run.ts'
import type { CaptureOutput } from './schema.ts'

interface Call {
  readonly prompt: string
  readonly signal: AbortSignal
  readonly answer: (result: RunResult<CaptureOutput>) => void
}

const USAGE = { inputTokens: 900, outputTokens: 40, costUsd: 0.0021, ms: 1500, model: 'claude-haiku-4-5' }

function parsed(value: Partial<CaptureOutput>): RunResult<CaptureOutput> {
  return { ok: true, value: { title: 'parsed', area: null, project: null, due: null, priority: 0, ...value }, usage: USAGE }
}

async function rig(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await mkdtemp(join(tmpdir(), 'tasks-capture-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const log = captureLog()
  const opened = await openBoardStore({ dir, timeZone: ZONE, now: NOW, log })
  if (!opened.ok) throw new Error(opened.reason)
  const store: BoardStore = opened.store
  const calls: Call[] = []
  const newId = counter('c')
  const clock = { ms: NOW.getTime() }
  const opContext = () => {
    clock.ms += 1000
    return { now: new Date(clock.ms), timeZone: ZONE, newId }
  }
  const capturer: Capturer = createCapturer({
    store,
    opContext,
    log,
    // Like the real run: an abort settles it as `stopped`.
    run: (prompt: string, signal: AbortSignal) =>
      new Promise<RunResult<CaptureOutput>>((resolve) => {
        signal.addEventListener('abort', () => resolve({ ok: false, reason: 'stopped' }), { once: true })
        calls.push({ prompt, signal, answer: resolve })
      }),
  })
  t.after(() => capturer.stop())
  const card = (id: string): Task | undefined => store.current().tasks.find((x) => x.id === id)
  const change = (op: (board: Board) => Result<{ readonly board: Board }>) => store.change(op)
  return { store, capturer, calls, log, card, change, opContext }
}

function ok<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`expected ok, got ${result.error.code}: ${result.error.reason}`)
  return result.value
}

const INPUT: CaptureInput = { text: 'entregar el informe de 8780 el viernes' }

test('crit. 21: the card is in triage, pending, with the text as its title, BEFORE claude answers', async (t) => {
  const { capturer, calls, card } = await rig(t)
  const created = ok(await capturer.capture(INPUT))
  assert.equal(created.status, 'triage')
  assert.equal(created.cycle, null)
  assert.equal(created.title, INPUT.text)
  assert.deepEqual(created.source, { kind: 'capture', raw: INPUT.text, parse: 'pending' })
  await eventually(() => calls.length === 1, 'the run started')
  assert.equal(card(created.id)?.source.kind === 'capture' && card(created.id)?.source, created.source)
})

test('a long or multi-line capture becomes a title of one line, at most 200, and keeps the whole raw', async (t) => {
  const { capturer } = await rig(t)
  const text = `línea uno\n\n  línea   dos ${'x'.repeat(300)}`
  const created = ok(await capturer.capture({ text }))
  assert.equal(created.title.length, 200)
  assert.ok(created.title.startsWith('línea uno línea dos x'))
  assert.equal(created.source.kind === 'capture' && created.source.raw, text)
})

test('crit. 22: a good answer fills title, area, project, due and priority, and parse is ok', async (t) => {
  const { capturer, calls, card, change, opContext } = await rig(t)
  // An area in use on the board, so it is on the closed list.
  const seed = ok(await capturer.capture({ text: 'seed' }))
  await eventually(() => calls.length === 1, 'seed run')
  calls[0]!.answer(parsed({ area: '8780' }))
  await eventually(() => card(seed.id)?.source.kind === 'capture' && (card(seed.id)?.source as { parse: string }).parse !== 'pending', 'seed parsed')
  // the seed got no area: 8780 was not on the list yet (no area on the board at the time).
  assert.equal(card(seed.id)?.area, null)
  ok(await change((board) => patchTask(board, seed.id, { area: '8780' }, opContext())))

  const created = ok(await capturer.capture({ ...INPUT, projects: [{ host: 'mac', siteId: 'factotum', name: 'Factotum' }] }))
  await eventually(() => calls.length === 2, 'the run started')
  assert.match(calls[1]!.prompt, /<area>8780<\/area>/)
  assert.match(calls[1]!.prompt, /<project id="p0" siteId="factotum">Factotum<\/project>/)
  calls[1]!.answer(parsed({ title: 'Entregar el informe', area: '8780', project: 'p0', due: '2026-10-16', priority: 2 }))
  await eventually(() => (card(created.id)?.source as { parse: string }).parse === 'ok', 'parsed')
  const after = card(created.id)!
  assert.equal(after.title, 'Entregar el informe')
  assert.equal(after.area, '8780')
  assert.deepEqual(after.project, { host: 'mac', siteId: 'factotum' })
  assert.equal(after.due, '2026-10-16')
  assert.equal(after.priority, 2)
  assert.equal(after.status, 'triage')
})

test('crit. 22: an area or a project off the closed list is dropped; without projects, no project at all', async (t) => {
  const { capturer, calls, card } = await rig(t)
  const created = ok(await capturer.capture(INPUT))
  await eventually(() => calls.length === 1, 'the run started')
  assert.match(calls[0]!.prompt, /There are no projects/)
  calls[0]!.answer(parsed({ area: 'Invented', project: 'p0', due: '2026-10-16' }))
  await eventually(() => (card(created.id)?.source as { parse: string }).parse === 'ok', 'parsed')
  assert.equal(card(created.id)?.area, null)
  assert.equal(card(created.id)?.project, null)
  assert.equal(card(created.id)?.due, '2026-10-16')
})

test('crit. 22: the prompt carries today in the board’s zone, so «el viernes» resolves there', async (t) => {
  const { capturer, calls } = await rig(t)
  ok(await capturer.capture(INPUT))
  await eventually(() => calls.length === 1, 'the run started')
  // NOW is 2026-10-13T23:00Z: still Tuesday in UTC, Wednesday in Sydney.
  assert.match(calls[0]!.prompt, /Today is Wednesday 2026-10-14, 10:00 in Australia\/Sydney/)
})

test('crit. 23: a failed run leaves the text as the title and parse failed', async (t) => {
  const { capturer, calls, card } = await rig(t)
  const created = ok(await capturer.capture(INPUT))
  await eventually(() => calls.length === 1, 'the run started')
  calls[0]!.answer({ ok: false, reason: 'claude gave no answer within 30 s' })
  await eventually(() => (card(created.id)?.source as { parse: string }).parse === 'failed', 'failed')
  assert.equal(card(created.id)?.title, INPUT.text)
})

test('crit. 23b: accepted to Todo while claude thinks — when it answers, the card does not change', async (t) => {
  const { capturer, calls, card, change, opContext, store } = await rig(t)
  const created = ok(await capturer.capture(INPUT))
  await eventually(() => calls.length === 1, 'the run started')
  ok(await change((board) => acceptTask(board, created.id, 'todo', opContext())))
  const accepted = card(created.id)
  calls[0]!.answer(parsed({ title: 'should not land', priority: 1 }))
  await eventually(() => (card(created.id)?.source as { parse: string }).parse === 'skipped', 'skipped')
  await store.idle()
  // Only its parse changes (design D5): no «parsing», no «Couldn't parse», nothing of the answer.
  assert.deepEqual(card(created.id), { ...accepted, source: { kind: 'capture', raw: INPUT.text, parse: 'skipped' } })
})

test('crit. 23b: the title edited in triage while claude thinks — the owner wins, and parse is skipped', async (t) => {
  const { capturer, calls, card, change, opContext } = await rig(t)
  const created = ok(await capturer.capture(INPUT))
  await eventually(() => calls.length === 1, 'the run started')
  ok(await change((board) => patchTask(board, created.id, { title: 'mine' }, opContext())))
  calls[0]!.answer(parsed({ title: 'should not land', priority: 1 }))
  await eventually(() => (card(created.id)?.source as { parse: string }).parse === 'skipped', 'skipped')
  assert.equal(card(created.id)?.title, 'mine')
  assert.equal(card(created.id)?.priority, 0)
})

test('a card deleted while claude thinks: the answer is dropped without a write', async (t) => {
  const { capturer, calls, store, change } = await rig(t)
  const created = ok(await capturer.capture(INPUT))
  await eventually(() => calls.length === 1, 'the run started')
  ok(await change((board) => ({ ok: true, value: { board: { ...board, tasks: board.tasks.filter((x) => x.id !== created.id) } } })))
  const before = store.current()
  calls[0]!.answer(parsed({}))
  await new Promise((resolve) => setTimeout(resolve, 50))
  await store.idle()
  assert.equal(store.current(), before)
})

test(`at most ${MAX_PARALLEL_PARSES} runs at a time; the third waits for a slot`, async (t) => {
  const { capturer, calls, card } = await rig(t)
  const ids: string[] = []
  for (const text of ['a', 'b', 'c']) ids.push(ok(await capturer.capture({ text })).id)
  await eventually(() => calls.length === 2, 'two runs')
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(calls.length, 2)
  calls[0]!.answer(parsed({ title: 'A' }))
  await eventually(() => calls.length === 3, 'the third run')
  calls[1]!.answer(parsed({ title: 'B' }))
  calls[2]!.answer(parsed({ title: 'C' }))
  await eventually(() => card(ids[2]!)?.title === 'C', 'the third parsed')
})

test('a queued capture the owner touched before its turn is skipped without spending a run', async (t) => {
  const { capturer, calls, card, change, opContext } = await rig(t)
  const ids: string[] = []
  for (const text of ['a', 'b', 'c']) ids.push(ok(await capturer.capture({ text })).id)
  await eventually(() => calls.length === 2, 'two runs')
  ok(await change((board) => patchTask(board, ids[2]!, { title: 'mine' }, opContext())))
  calls[0]!.answer(parsed({}))
  await eventually(() => (card(ids[2]!)?.source as { parse: string }).parse === 'skipped', 'skipped')
  assert.equal(calls.length, 2)
})

test('crit. 41: the log carries the id, the time, the tokens and the cost — never the text', async (t) => {
  const { capturer, calls, card, log } = await rig(t)
  const secret = 'pagar la multa secreta de Ana'
  const created = ok(await capturer.capture({ text: secret }))
  await eventually(() => calls.length === 1, 'the run started')
  calls[0]!.answer(parsed({ title: `${secret} ya` }))
  await eventually(() => (card(created.id)?.source as { parse: string }).parse === 'ok', 'parsed')
  const second = ok(await capturer.capture({ text: secret }))
  await eventually(() => calls.length === 2, 'second run')
  calls[1]!.answer({ ok: false, reason: 'claude answered outside the schema' })
  await eventually(() => (card(second.id)?.source as { parse: string }).parse === 'failed', 'failed')
  const all = log.lines.join('\n')
  assert.equal(all.includes('multa'), false)
  assert.match(all, new RegExp(`capture ${created.id} parsed in 1500 ms, 900 in / 40 out, \\$0\\.0021`))
  assert.match(all, new RegExp(`capture ${second.id} could not be parsed: claude answered outside the schema`))
})

test('stop aborts the runs in flight and writes nothing after', async (t) => {
  const { capturer, calls, card } = await rig(t)
  const created = ok(await capturer.capture(INPUT))
  await eventually(() => calls.length === 1, 'the run started')
  const stopping = capturer.stop()
  assert.equal(calls[0]!.signal.aborted, true)
  calls[0]!.answer({ ok: false, reason: 'stopped' })
  await stopping
  assert.equal((card(created.id)?.source as { parse: string }).parse, 'pending')
  const late = await capturer.capture(INPUT)
  assert.equal(late.ok, false)
})
