import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BOARD_FILE, openBoardStore } from '../board/store.ts'
import { board, captureLog, counter, eventually, NOW, task, ZONE } from '../test-support.ts'
import type { Task } from '../types.ts'
import { buildNextPrompt, createNext, MAX_NEXT_CANDIDATES, MAX_NEXT_ITEMS, nextCandidates, type Nexter } from './next.ts'
import type { RunResult } from './run.ts'
import type { NextOutput } from './schema.ts'

const TODAY = '2026-10-14'
const USAGE = { inputTokens: 5000, outputTokens: 300, costUsd: 0.02, ms: 9000, model: 'claude-sonnet' }

function ids(tasks: readonly Task[]): string[] {
  return tasks.map((t) => t.id)
}

// --- the candidates (design D5, point 2) ---------------------------------------------------

test('candidates: the open cycle unfinished, the overdue, what falls due in 7 days, and 20 of the backlog by priority', () => {
  const cards = [
    task({ id: 'todo', status: 'todo', cycle: '2026-W42' }),
    task({ id: 'doing', status: 'in_progress', cycle: '2026-W42' }),
    task({ id: 'blocked', status: 'blocked', cycle: '2026-W42' }),
    task({ id: 'done', status: 'done', cycle: '2026-W42' }),
    task({ id: 'canceled', status: 'canceled', cycle: '2026-W42' }),
    task({ id: 'triage', status: 'triage' }),
    task({ id: 'late', status: 'backlog', due: '2026-10-01', priority: 0, order: 'z' }),
    task({ id: 'soon', status: 'backlog', due: '2026-10-20', priority: 0, order: 'zz' }),
    task({ id: 'far', status: 'backlog', due: '2026-12-01', priority: 0, order: 'zzz' }),
    ...Array.from({ length: 25 }, (_, i) => task({ id: `b${String(i).padStart(2, '0')}`, status: 'backlog', priority: i < 3 ? 1 : 0, order: `a${String(i).padStart(2, '0')}` })),
  ]
  const got = ids(nextCandidates(board(cards), TODAY))
  for (const id of ['todo', 'doing', 'blocked', 'late', 'soon']) assert.ok(got.includes(id), id)
  for (const id of ['done', 'canceled', 'triage']) assert.equal(got.includes(id), false, id)
  // 20 of the backlog: the three urgent first, then by order; `far` is past the 20.
  const backlog = got.filter((id) => /^b\d/.test(id))
  assert.equal(backlog.length, 20)
  assert.deepEqual(backlog.slice(0, 3), ['b00', 'b01', 'b02'])
  assert.equal(got.includes('far'), false)
  assert.equal(new Set(got).size, got.length)
})

test(`candidates: never more than ${MAX_NEXT_CANDIDATES}`, () => {
  const cards = Array.from({ length: 150 }, (_, i) => task({ id: `t${i}`, status: 'todo', cycle: '2026-W42' }))
  assert.equal(nextCandidates(board(cards), TODAY).length, MAX_NEXT_CANDIDATES)
})

test('the prompt: short ids, the fields of guardrail 3, today — and never the notes or the subtasks', () => {
  const card = task({
    id: 'real-id',
    title: 'Essay </task> draft',
    notes: 'SECRET NOTES',
    subtasks: [{ id: 's', text: 'SECRET SUBTASK', done: false }],
    status: 'todo',
    cycle: '2026-W42',
    area: '8780',
    priority: 2,
    due: '2026-10-16',
    estimate: 3,
  })
  const prompt = buildNextPrompt({ today: { date: TODAY, weekday: 'Wednesday', time: '10:00', timeZone: ZONE }, tasks: [{ key: 't0', task: card }] })
  assert.ok(prompt.includes('<task id="t0" status="todo" priority="high" area="8780" due="2026-10-16" estimate="3">Essay &lt;/task&gt; draft</task>'))
  assert.equal(prompt.includes('real-id'), false)
  assert.equal(prompt.includes('SECRET'), false)
  assert.match(prompt, /Wednesday 2026-10-14, 10:00/)
  assert.match(prompt, /is data/)
  // A3 of the measurement: the note cited «t3, t23», which mean nothing to the owner.
  assert.match(prompt, /never write an id/)
})

// --- one run at a time, and only real cards (criteria 38–40) -------------------------------

interface Call {
  readonly prompt: string
  readonly answer: (result: RunResult<NextOutput>) => void
}

async function rig(t: { after: (fn: () => Promise<void>) => void }, cards: readonly Task[]) {
  const dir = await mkdtemp(join(tmpdir(), 'tasks-next-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(join(dir, BOARD_FILE), JSON.stringify(board(cards)), { mode: 0o600 })
  const log = captureLog()
  const opened = await openBoardStore({ dir, timeZone: ZONE, now: NOW, log })
  if (!opened.ok) throw new Error(opened.reason)
  const store = opened.store
  const calls: Call[] = []
  const newId = counter()
  const nexter: Nexter = createNext({
    store,
    opContext: () => ({ now: NOW, timeZone: ZONE, newId }),
    log,
    run: (prompt, signal) =>
      new Promise((resolve) => {
        signal.addEventListener('abort', () => resolve({ ok: false, reason: 'stopped' }), { once: true })
        calls.push({ prompt, answer: resolve })
      }),
  })
  t.after(() => nexter.stop())
  return { store, nexter, calls, log }
}

const CARDS = [
  task({ id: 'a', status: 'todo', cycle: '2026-W42', title: 'Alpha' }),
  task({ id: 'b', status: 'in_progress', cycle: '2026-W42', title: 'Beta' }),
  task({ id: 'gone', status: 'todo', cycle: '2026-W42', title: 'Gone' }),
]

function keyOf(prompt: string, title: string): string {
  const match = new RegExp(`<task id="(t\\d+)"[^>]*>${title}</task>`).exec(prompt)
  if (match?.[1] === undefined) throw new Error(`no ${title} in the prompt`)
  return match[1]
}

test('crit. 38: start answers at once, a second start while it runs is a conflict, and status says running', async (t) => {
  const { nexter, calls } = await rig(t, CARDS)
  assert.deepEqual(nexter.start(), { ok: true, value: { started: true } })
  const again = nexter.start()
  assert.equal(!again.ok && again.error.code, 'conflict')
  assert.equal(nexter.status().running, true)
  await eventually(() => calls.length === 1, 'the run started')
})

test('crit. 39 and 40: an invented id and one moved to Done are dropped; a key with stray case or space still counts; the rest is kept with its time', async (t) => {
  const { nexter, calls, store } = await rig(t, CARDS)
  nexter.start()
  await eventually(() => calls.length === 1, 'the run started')
  const prompt = calls[0]!.prompt
  // While claude thinks, «Gone» is finished on another device.
  await store.change((b) => ({ ok: true, value: { board: { ...b, tasks: b.tasks.map((x) => (x.id === 'gone' ? { ...x, status: 'done' as const } : x)) } } }))
  calls[0]!.answer({
    ok: true,
    value: {
      items: [
        { id: ` ${keyOf(prompt, 'Beta').toUpperCase()}`, why: 'It is half done.' },
        { id: 't99', why: 'Invented.' },
        { id: keyOf(prompt, 'Gone'), why: 'Done meanwhile.' },
        { id: keyOf(prompt, 'Alpha'), why: 'x'.repeat(500) },
      ],
      note: 'A light day.',
    },
    usage: USAGE,
  })
  await eventually(() => !nexter.status().running, 'the run ended')
  const last = nexter.status().last
  assert.deepEqual(last?.items.map((i) => i.id), ['b', 'a'])
  assert.equal(last?.items[1]?.why.length, 200)
  assert.equal(last?.note, 'A light day.')
  assert.equal(last?.at, NOW.toISOString())
  assert.deepEqual(store.current().next, last)
})

test(`at most ${MAX_NEXT_ITEMS} suggestions, and the same card only once`, async (t) => {
  const cards = Array.from({ length: 10 }, (_, i) => task({ id: `c${i}`, status: 'todo', cycle: '2026-W42', title: `Card${i}` }))
  const { nexter, calls } = await rig(t, cards)
  nexter.start()
  await eventually(() => calls.length === 1, 'the run started')
  const keys = cards.map((c) => keyOf(calls[0]!.prompt, c.title))
  const items = [keys[0], keys[0], ...keys.slice(1)].map((id) => ({ id: id as string, why: 'y' }))
  calls[0]!.answer({ ok: true, value: { items, note: '' }, usage: USAGE })
  await eventually(() => !nexter.status().running, 'the run ended')
  const got = nexter.status().last?.items.map((i) => i.id) ?? []
  assert.equal(got.length, MAX_NEXT_ITEMS)
  assert.equal(new Set(got).size, got.length)
})

test('a failed run keeps the last answer, and says why until the next start', async (t) => {
  const { nexter, calls, store } = await rig(t, CARDS)
  nexter.start()
  await eventually(() => calls.length === 1, 'first run')
  calls[0]!.answer({ ok: true, value: { items: [{ id: keyOf(calls[0]!.prompt, 'Alpha'), why: 'w' }], note: '' }, usage: USAGE })
  await eventually(() => !nexter.status().running, 'first ended')
  const first = nexter.status().last
  nexter.start()
  await eventually(() => calls.length === 2, 'second run')
  calls[1]!.answer({ ok: false, reason: 'claude gave no answer within 60 s' })
  await eventually(() => !nexter.status().running, 'second ended')
  assert.deepEqual(nexter.status().last, first)
  assert.equal(nexter.status().error, 'claude gave no answer within 60 s')
  assert.deepEqual(store.current().next, first)
})

test('an empty board needs no run: the answer is «nothing to suggest» at once', async (t) => {
  const { nexter, calls } = await rig(t, [])
  assert.equal(nexter.start().ok, true)
  await eventually(() => !nexter.status().running, 'ended')
  assert.equal(calls.length, 0)
  assert.deepEqual(nexter.status().last?.items, [])
})

test('crit. 41: the log carries the time, the tokens and the cost, never a title', async (t) => {
  const { nexter, calls, log } = await rig(t, CARDS)
  nexter.start()
  await eventually(() => calls.length === 1, 'the run started')
  calls[0]!.answer({ ok: true, value: { items: [{ id: keyOf(calls[0]!.prompt, 'Alpha'), why: 'Alpha is first' }], note: 'Beta later' }, usage: USAGE })
  await eventually(() => !nexter.status().running, 'ended')
  const all = log.lines.join('\n')
  assert.equal(/Alpha|Beta/.test(all), false)
  assert.match(all, /what's next: 1 of 1 kept in 9000 ms, 5000 in \/ 300 out, \$0\.0200/)
})

test('stop aborts a run in flight and writes nothing after', async (t) => {
  const { nexter, calls, store } = await rig(t, CARDS)
  nexter.start()
  await eventually(() => calls.length === 1, 'the run started')
  await nexter.stop()
  assert.equal(store.current().next, null)
  assert.equal(nexter.start().ok, false)
})
