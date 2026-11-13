/**
 * E4 — GUARDRAIL 1 (spec 2026-11-12-postulaciones, requirements G1): nothing sends an email by itself.
 * SMTP is reached only from `decide({ kind: 'approve' })`, «Send again» (`resolveUnknown(…, 'again')`)
 * and «Retry» (`retrySend`) — each one a click of the owner.
 *
 * WHY HERE: this is the composition root, the only package that sees BOTH the module's route table
 * (`@factotum/modules`, which imports only core) and the engine (`@factotum/jobs`, which knows no HTTP).
 * The module is built exactly as `main.ts` builds it — `jobsModule(createJobs)` — with only the seams a
 * test needs: the SMTP send spied, fake-claude, the network refused, and timers whose intervals fire
 * when the test says so.
 *
 * NOTHING IS LISTED BY HAND. The routes are the keys of the real table; the clock is every interval the
 * engine arms on `ctx.timers` (the kernel owns every timer, CLAUDE.md §6), fired round after round with
 * the day moving. A route or a clock task added later (F3b, K, U…) is walked without touching this file.
 * Every request that is not one of the three is sent with every body shape the routes read — the
 * send-shaped ones included — and must leave the spy untouched; the three are then each shown to reach it.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Logger, ModuleContext, ModuleRequest, ModuleResponse, RouteTable, Timers } from '@factotum/core'
import { closeApplication, createJobs, createTestApplication, openDb, type JobsDeps } from '@factotum/jobs'
import { eventually, FAKE_CLAUDE, NOW, rigIn, type Rig } from '@factotum/jobs/testing'
import { jobsModule } from '@factotum/modules'

type SendResult = Awaited<ReturnType<NonNullable<JobsDeps['sendMail']>>>
type Outcome = 'ok' | 'unknown' | 'failed'

const OUTCOMES: Readonly<Record<Outcome, SendResult>> = {
  ok: { ok: true, messageId: '<spied@jobs.factotum.local>', response: '250 OK' },
  // After DATA: the server may have taken it → `send-unknown`.
  unknown: { ok: false, phase: 'after-data', reason: 'connection lost after the body' },
  // Before DATA: certainly not sent → `failed`.
  failed: { ok: false, phase: 'before-data', reason: '421 try later' },
}

const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS
/** The fixture's wave 2 holds until 2027-01-12; its CVs are queued 7 days before. */
const WAVE2_DUE = new Date('2027-01-06T00:00:00.000Z')
const SETTLE_MS = 30_000
/** After the store is quiet, a short grace for a send launched without moving any state. */
const GRACE_MS = 100
const TEST_TO = 'owner@example.test'

/** The three explicit requests that may reach SMTP — and nothing else. */
function isSendRequest(route: string, body: unknown): boolean {
  const field = (name: string): unknown => (typeof body === 'object' && body !== null ? (body as Record<string, unknown>)[name] : undefined)
  if (route === 'POST /batch/decide') return field('kind') === 'approve'
  if (route === 'POST /a/:id/sends/:kind/unknown') return field('answer') === 'again'
  return route === 'POST /a/:id/sends/:kind/retry'
}

interface World {
  readonly rig: Rig
  readonly table: RouteTable
  readonly calls: string[]
  readonly tick: () => number
  readonly advance: (ms: number) => void
  readonly setNow: (at: Date) => void
  /** What the spy answers next. */
  outcome: Outcome
  /** The test applications made so far. */
  readonly tests: string[]
  /** The last request issued: who a call is pinned on. */
  last: string
  readonly stop: () => Promise<void>
}

const SILENT: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined }

async function world(): Promise<World> {
  const rig = rigIn(mkdtempSync(join(tmpdir(), 'factotum-g1-')))
  const intervals: (() => void)[] = []
  // Intervals are the clock's: fired by the test. Timeouts (deadlines, courtesy waits) run for real.
  const timers: Timers = {
    setInterval: (fn) => {
      intervals.push(fn)
      return { [Symbol.dispose]: () => void intervals.splice(intervals.indexOf(fn), 1) }
    },
    setTimeout: (fn, ms) => {
      const handle = setTimeout(fn, ms)
      handle.unref()
      return { [Symbol.dispose]: () => clearTimeout(handle) }
    },
  }
  let at = NOW.getTime()
  const w: World = {
    rig,
    table: {},
    calls: [],
    tests: [],
    tick: () => {
      for (const fn of [...intervals]) fn()
      return intervals.length
    },
    advance: (ms) => void (at += ms),
    setNow: (to) => void (at = to.getTime()),
    outcome: 'ok',
    last: 'start',
    stop: async () => undefined,
  }
  const sendMail: NonNullable<JobsDeps['sendMail']> = async () => {
    w.calls.push(w.last)
    return OUTCOMES[w.outcome]
  }
  // As `main.ts`: `jobsModule(createJobs)` — the factory given the test's seams on top of the module's.
  const module = jobsModule((deps) =>
    createJobs({ ...deps, claudeBin: FAKE_CLAUDE, sendMail, fetch: async () => Promise.reject(new Error('offline')), lookup: async () => ['93.184.216.34'] }),
  )
  const ctx = {
    config: rig.config,
    stateDir: rig.stateDir,
    env: 'dev',
    log: SILENT,
    now: () => new Date(at),
    timers,
    notify: async () => undefined,
    peers: { list: () => [], call: async () => ({ ok: false, reason: 'no peers' }) },
  } as unknown as ModuleContext<unknown>
  if (module.routes === undefined) assert.fail('jobs has a route table')
  const table = module.routes(ctx)
  const started = await module.start?.(ctx)
  return Object.assign(w, { table, stop: async () => started?.stop?.() })
}

function request(route: string, params: Readonly<Record<string, string>>, body: unknown): ModuleRequest {
  const [method = 'GET', path = '/'] = route.split(' ')
  return { method, path, params, query: {}, body } as unknown as ModuleRequest
}

/** A request; `pin` names it as the one an SMTP call from now on is pinned on (the test's own reads do not). */
async function call(w: World, route: string, params: Readonly<Record<string, string>> = {}, body?: unknown, pin = true): Promise<ModuleResponse> {
  const handler = w.table[route]
  if (handler === undefined) assert.fail(`no route ${route}`)
  if (pin) w.last = `${route} ${JSON.stringify(params)} ${JSON.stringify(body) ?? ''}`
  return await (handler as (req: ModuleRequest) => Promise<ModuleResponse>)(request(route, params, body))
}

const bodyOf = <T>(response: ModuleResponse): T => (response as { body: T }).body

interface Counts {
  readonly counts: Readonly<Record<string, number>>
}

const BUSY = ['generating', 'sending']

/** Something generating or sending — the overview does not count the test application, so it is asked apart. */
async function busy(w: World): Promise<boolean> {
  const { counts } = bodyOf<Counts>(await call(w, 'GET /overview', {}, undefined, false))
  if (BUSY.some((state) => (counts[state] ?? 0) > 0)) return true
  for (const id of w.tests) {
    const card = bodyOf<{ application?: { state: string } }>(await call(w, 'GET /a/:id', { id }, undefined, false))
    if (BUSY.includes(card.application?.state ?? '')) return true
  }
  return false
}

/** Waits until nothing is generating or sending, then a short grace. */
async function settle(w: World): Promise<void> {
  await eventually(async () => !(await busy(w)), 'the store went quiet', SETTLE_MS)
  await new Promise((resolve) => setTimeout(resolve, GRACE_MS))
}

/** `:id` → each application given and one that does not exist; `:kind` → every kind; the rest, a plausible value. */
function paramSets(route: string, ids: readonly string[]): readonly Record<string, string>[] {
  const names = [...route.matchAll(/:([A-Za-z]+)/g)].map((match) => match[1] ?? '')
  const values = (name: string): readonly string[] => {
    if (name === 'id') return [...ids, 'nope']
    if (name === 'kind') return ['initial', 'followup-1', 'followup-2']
    if (name === 'version') return ['1']
    if (name === 'name') return ['Some-One-CV.pdf']
    return ['nope']
  }
  return names.reduce<Record<string, string>[]>((sets, name) => sets.flatMap((set) => values(name).map((value) => ({ ...set, [name]: value }))), [{}])
}

interface Item {
  readonly itemId: string
  readonly seen: string
}

/** Every body shape a route reads, the send-shaped ones included, built from what the screen sees now. */
async function bodies(w: World, ids: readonly string[]): Promise<readonly unknown[]> {
  const batch = bodyOf<{ batch: { items: readonly Item[] } | null }>(await call(w, 'GET /batch')).batch
  const profile = bodyOf<{ profile: unknown }>(await call(w, 'GET /profile')).profile
  const decisions = (batch?.items ?? []).flatMap(({ itemId, seen }) => [
    { itemId, seen, kind: 'approve', addressOverride: true },
    { itemId, seen, kind: 'override', warningCodes: ['unsupported-claim'] },
    { itemId, seen, kind: 'switch-channel' },
    { itemId, seen, kind: 'instruct', text: 'Shorter, please.' },
    { itemId, seen, kind: 'switch-to-form' },
    { itemId, seen, kind: 'skip', reason: 'not-now' },
  ])
  // A send answer carries the row as the screen read it (`expect`, required): one per application with a row.
  const expects = (await Promise.all(ids.map((id) => call(w, 'GET /a/:id/sends/:kind', { id, kind: 'initial' }))))
    .filter((read) => read.status === 200)
    .map((read) => bodyOf<{ state: string; at: string }>(read))
    .map(({ state, at }) => ({ state, at }))
  return [
    undefined,
    {},
    { dryRun: true },
    { dryRun: false },
    { answer: 'again' },
    { answer: 'went' },
    { answer: 'not-went' },
    ...expects.flatMap((expect) => [{ answer: 'again', expect }, { answer: 'went', expect }, { answer: 'not-went', expect }, { expect }]),
    { job: 'cv' },
    { job: 'letter' },
    { job: 'reprint' },
    profile,
    { text: 'Be brief.', scope: 'all' },
    { enabled: false },
    ...decisions,
  ]
}

/** Every route of the real table with every body, except the three send requests: not one SMTP call. */
async function walkRoutes(w: World, ids: readonly string[], when: string): Promise<void> {
  const before = w.calls.length
  const shapes = await bodies(w, ids)
  let requests = 0
  for (const route of Object.keys(w.table)) {
    for (const params of paramSets(route, ids)) {
      for (const body of route.startsWith('GET ') ? [undefined] : shapes) {
        if (isSendRequest(route, body)) continue
        await call(w, route, params, body)
        requests += 1
        // A send moves its row to `sending` in the request's own `tx`: wait for it here, so the call is pinned on this request.
        if (await busy(w)) await settle(w)
      }
    }
  }
  await settle(w)
  assert.ok(requests > Object.keys(w.table).length, 'every route was called')
  assert.deepEqual(w.calls.slice(before), [], `${when}: a request that is not approve, «Send again» or «Retry» reached SMTP`)
}

/** Every interval the engine armed, round after round, the day moving: not one SMTP call. */
async function walkClock(w: World, when: string): Promise<void> {
  const before = w.calls.length
  for (const step of [0, 2 * HOUR_MS, DAY_MS, 3 * DAY_MS]) {
    w.advance(step)
    w.last = `the clock (+${step} ms)`
    assert.ok(w.tick() > 0, 'the clock is armed')
    await settle(w)
  }
  assert.deepEqual(w.calls.slice(before), [], `${when}: the clock reached SMTP`)
}

/** A fresh test application (the CLI's way, beside the daemon), its CV back through the clock's pump. */
async function testApplication(w: World, previous: string | null): Promise<string> {
  const db = await openDb({ dir: w.rig.stateDir, now: () => new Date() })
  if (!db.ok) assert.fail(db.error.reason)
  try {
    if (previous !== null) closeApplication(db.value, { now: () => new Date() }, previous, { reason: 'next test' })
    const created = createTestApplication(db.value, { now: () => new Date() }, { to: TEST_TO })
    if (!created.ok) assert.fail(created.error.reason)
    const id = created.value.id
    w.tests.push(id)
    await eventually(async () => {
      w.tick()
      const card = bodyOf<{ application: { state: string } }>(await call(w, 'GET /a/:id', { id }))
      return card.application?.state === 'ready'
    }, 'the test application is ready', SETTLE_MS)
    return id
  } finally {
    db.value.close()
  }
}

async function sendState(w: World, id: string): Promise<string> {
  await settle(w)
  return bodyOf<{ state: string }>(await call(w, 'GET /a/:id/sends/:kind', { id, kind: 'initial' })).state
}

/** The row as the screen read it: what every send answer carries (`expect`, required). */
async function expectOf(w: World, id: string): Promise<{ readonly state: string; readonly at: string }> {
  const { state, at } = bodyOf<{ state: string; at: string }>(await call(w, 'GET /a/:id/sends/:kind', { id, kind: 'initial' }))
  return { state, at }
}

/** «Approve» then «Send anyway» once its address check has finished (`check-pending` until then). */
async function approve(w: World, id: string): Promise<void> {
  let answer: ModuleResponse | undefined
  await eventually(async () => {
    const batch = bodyOf<{ batch: { items: readonly (Item & { application?: { id: string } })[] } | null }>(await call(w, 'POST /batch')).batch
    const item = batch?.items.find((i) => i.application?.id === id)
    if (item === undefined) assert.fail('the test application is in its batch')
    answer = await call(w, 'POST /batch/decide', {}, { itemId: item.itemId, seen: item.seen, kind: 'approve', addressOverride: true })
    w.tick()
    return answer.status !== 409
  }, 'approve went through', SETTLE_MS)
  assert.equal(answer?.status, 200, JSON.stringify(answer))
}

/** Asserts `act` reached SMTP exactly once, and the send ended in `state`. */
async function reaches(w: World, outcome: Outcome, id: string, state: string, act: () => Promise<unknown>): Promise<void> {
  const before = w.calls.length
  w.outcome = outcome
  await act()
  assert.equal(await sendState(w, id), state)
  assert.equal(w.calls.length - before, 1, 'one SMTP call, from that click')
}

test('guardrail 1: only approve, «Send again» and «Retry» reach SMTP — every route and every clock task walked', { timeout: 300_000 }, async () => {
  const w = await world()
  try {
    assert.equal(bodyOf<{ dryRun: boolean }>(await call(w, 'POST /import', {}, { dryRun: false })).dryRun, false)
    await settle(w)
    const seeded = bodyOf<{ batch: { items: readonly { application?: { id: string } }[] } }>(await call(w, 'POST /batch')).batch
    const ids = seeded.items.flatMap((i) => (i.application === undefined ? [] : [i.application.id])).slice(0, 2)

    // The seed's world: ready, in review, held drafts.
    await walkClock(w, 'after the import')
    await walkRoutes(w, ids, 'after the import')

    // «Approve» reaches SMTP; the answer is lost after the body → «send-unknown».
    const first = await testApplication(w, null)
    await reaches(w, 'unknown', first, 'send-unknown', () => approve(w, first))
    await walkClock(w, 'with a send-unknown')
    await walkRoutes(w, [...ids, first], 'with a send-unknown')

    // «Send again» reaches it; refused before the body → failed.
    const second = await testApplication(w, first)
    await reaches(w, 'unknown', second, 'send-unknown', () => approve(w, second))
    await reaches(w, 'failed', second, 'failed', async () => call(w, 'POST /a/:id/sends/:kind/unknown', { id: second, kind: 'initial' }, { answer: 'again', expect: await expectOf(w, second) }))
    await walkClock(w, 'with a failed send')
    await walkRoutes(w, [...ids, second], 'with a failed send')

    // «Retry» reaches it → sent.
    const third = await testApplication(w, second)
    await reaches(w, 'failed', third, 'failed', () => approve(w, third))
    await reaches(w, 'ok', third, 'sent', async () => call(w, 'POST /a/:id/sends/:kind/retry', { id: third, kind: 'initial' }, { expect: await expectOf(w, third) }))

    // Wave 2 comes due and the daily copy is taken: the clock's tasks really ran.
    w.setNow(WAVE2_DUE)
    await walkClock(w, 'with wave 2 due')
    await walkRoutes(w, [...ids, third], 'after a sent one')
    assert.ok(readdirSync(join(w.rig.stateDir, 'backups')).length > 0, 'the daily copy ran')
    assert.equal(w.calls.length, 5, 'exactly the five clicks above')
  } finally {
    await w.stop()
    rmSync(join(w.rig.stateDir, '..'), { recursive: true, force: true })
  }
})
