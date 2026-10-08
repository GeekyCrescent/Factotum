import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Logger, NotificationMessage, PushEnvelope } from '@factotum/core'
import { acceptRelayed, fitRelayed, RELAY_LIMITS, RELAY_MAX_BODY_BYTES, RELAY_RATE, tokenBucket } from './relay.ts'
import { MAX_PLAINTEXT_BYTES } from './send.ts'

/** The Mac, as the Linux knows it: its one declared peer. */
const MAC = 'juans-macbook-pro'
const PEERS = [{ name: MAC }] as const

const ask: NotificationMessage = {
  title: 'permission',
  body: 'proyecto-a wants to run Bash',
  path: '/m/sessions/s1?ask=tok',
  tag: 's1',
  actions: [{ action: 'allow', label: 'Allow' }],
  data: { askId: 'tok' },
  until: '2026-10-08T10:00:00.000Z',
}

const relayed = (extra: Partial<PushEnvelope> = {}): PushEnvelope => ({ message: ask, moduleId: 'sessions', machine: MAC, ...extra })

function capture(): { log: Logger; lines: string[] } {
  const lines: string[] = []
  const keep = (line: string) => void lines.push(line)
  return { log: { info: keep, warn: keep, error: keep }, lines }
}

// ---------------------------------------------------------------------------
// acceptRelayed: the rules of design D6 that live in the envelope (criterion 16)
// ---------------------------------------------------------------------------

test('the path is rewritten under /h/<machine>, so a tap opens the peer inside this app', () => {
  const verdict = acceptRelayed(relayed(), PEERS)

  assert.equal(verdict.ok, true)
  assert.equal(verdict.ok && verdict.envelope.message.path, `/h/${MAC}/m/sessions/s1?ask=tok`)
})

test('data.host is added, and what the peer put in data is kept', () => {
  const verdict = acceptRelayed(relayed(), PEERS)

  assert.deepEqual(verdict.ok && verdict.envelope.message.data, { askId: 'tok', host: MAC })
})

test('data.host is added to a notice that had no data', () => {
  const { data: _data, ...plain } = ask
  const verdict = acceptRelayed(relayed({ message: plain }), PEERS)

  assert.deepEqual(verdict.ok && verdict.envelope.message.data, { host: MAC })
})

test('a host the peer put in data is overwritten: the machine is the one this host checked', () => {
  const verdict = acceptRelayed(relayed({ message: { ...ask, data: { host: 'omarchy' } } }), PEERS)

  assert.deepEqual(verdict.ok && verdict.envelope.message.data, { host: MAC })
})

test("the peer's machine is KEPT, not this host's: the title sw.js paints is `juans-macbook-pro: …` (criterion 15)", () => {
  const verdict = acceptRelayed(relayed(), PEERS)

  assert.equal(verdict.ok && verdict.envelope.machine, MAC)
  assert.equal(verdict.ok && verdict.envelope.moduleId, 'sessions')
  // Everything else in the message travels untouched.
  const { path: _p, data: _d, ...rest } = verdict.ok ? verdict.envelope.message : ask
  const { path: _p2, data: _d2, ...original } = ask
  assert.deepEqual(rest, original)
})

test('a machine that is not the declared peer is 403 relay-refused (criterion 16)', () => {
  const verdict = acceptRelayed(relayed({ machine: 'omarchy' }), PEERS)

  assert.equal(verdict.ok, false)
  assert.equal(!verdict.ok && verdict.status, 403)
  assert.equal(!verdict.ok && verdict.code, 'relay-refused')
})

test('with no peers at all, every machine is refused', () => {
  assert.equal(acceptRelayed(relayed(), []).ok, false)
})

test('a body that is not an envelope is 400 and names the field', () => {
  for (const body of [undefined, 'x', {}, { ...relayed(), message: { ...ask, title: 7 } }, { ...relayed(), machine: 'UP' }]) {
    const verdict = acceptRelayed(body, PEERS)
    assert.equal(!verdict.ok && verdict.status, 400, JSON.stringify(body))
    assert.equal(!verdict.ok && verdict.code, 'invalid-request')
  }
})

test('a path that is not absolute, or that would name another origin, is 400', () => {
  for (const path of ['m/sessions', '//evil.com/x', '', '/../push', '/m/./x', '/m/%2e%2e/x', '/m%2fx', '/m\\..\\push', '/m/..?x=1', '/m/.\t./x', '/m/x\n', '/m/a b']) {
    const verdict = acceptRelayed(relayed({ message: { ...ask, path } }), PEERS)
    assert.equal(!verdict.ok && verdict.status, 400, path)
  }
})

test('the query is the notice’s own: dots and escapes there are not a path', () => {
  const verdict = acceptRelayed(relayed({ message: { ...ask, path: '/m/sessions/search?q=..%2Fsrc' } }), PEERS)
  assert.equal(verdict.ok && verdict.envelope.message.path, `/h/${MAC}/m/sessions/search?q=..%2Fsrc`)
})

test('the daemon of the peer (moduleId null) can be relayed too', () => {
  const verdict = acceptRelayed(relayed({ moduleId: null }), PEERS)
  assert.equal(verdict.ok && verdict.envelope.moduleId, null)
})

test('keys the schema does not know are dropped, not forwarded to the push service', () => {
  const verdict = acceptRelayed({ ...relayed(), extra: 'x', message: { ...ask, smuggled: 'y' } }, PEERS)

  assert.equal(verdict.ok, true)
  assert.doesNotMatch(JSON.stringify(verdict.ok && verdict.envelope), /extra|smuggled/)
})

// ---------------------------------------------------------------------------
// fitRelayed: the ADR-0008 cap, checked AFTER data.host was added
// ---------------------------------------------------------------------------

test('an envelope under the cap goes as it is, and nothing is logged', () => {
  const { log, lines } = capture()
  const envelope = relayed()

  assert.equal(fitRelayed(envelope, log), envelope)
  assert.deepEqual(lines, [])
})

test('over the cap only because of data, it goes WITHOUT data — and the log says so, with no content', () => {
  const { log, lines } = capture()
  const secret = 'SEEDED-SECRET'
  const bulky = { ...ask, data: { askId: 'tok', note: secret + 'x'.repeat(MAX_PLAINTEXT_BYTES) } }

  const fitted = fitRelayed(relayed({ message: bulky }), log)

  assert.equal(fitted.message.data, undefined)
  assert.equal(fitted.message.title, ask.title)
  assert.equal(fitted.message.path, ask.path, 'the path still opens the right place')
  assert.equal(fitted.machine, MAC)
  assert.equal(lines.length, 1)
  assert.match(lines[0] ?? '', new RegExp(`${MAC}.*without its data`))
  assert.doesNotMatch(lines.join('\n'), new RegExp(`${secret}|tok|permission`))
})

// ---------------------------------------------------------------------------
// Hardening (security review, 2026-10-08): sizes, data, moduleId, and a token bucket
// ---------------------------------------------------------------------------

test('moduleId must be a module id: lowercase letters, digits and dashes', () => {
  for (const moduleId of ['Sessions', 'a/b', '../x', '', 'a b', 'x'.repeat(65)]) {
    const verdict = acceptRelayed(relayed({ moduleId }), PEERS)
    assert.equal(!verdict.ok && verdict.status, 400, moduleId)
  }
  assert.equal(acceptRelayed(relayed({ moduleId: 'my-module-2' }), PEERS).ok, true)
})

test('title, body, tag and path are capped well under the push cap', () => {
  const long = (n: number) => 'x'.repeat(n)
  for (const message of [
    { ...ask, title: long(RELAY_LIMITS.title + 1) },
    { ...ask, body: long(RELAY_LIMITS.body + 1) },
    { ...ask, tag: long(RELAY_LIMITS.tag + 1) },
    { ...ask, path: `/${long(RELAY_LIMITS.path)}` },
  ]) {
    assert.equal(acceptRelayed(relayed({ message }), PEERS).ok, false)
  }
  assert.equal(acceptRelayed(relayed({ message: { ...ask, title: long(RELAY_LIMITS.title) } }), PEERS).ok, true)
})

test('data takes scalar values only — the questions notice carries a number — and nothing nested', () => {
  const ok = acceptRelayed(relayed({ message: { ...ask, data: { kind: 'questions', count: 2, seen: false, none: null } } }), PEERS)
  assert.deepEqual(ok.ok && ok.envelope.message.data, { kind: 'questions', count: 2, seen: false, none: null, host: MAC })

  for (const data of [{ nested: { a: 'b' } }, { list: ['a'] }, { 'bad key': 'x' }, { long: 'x'.repeat(RELAY_LIMITS.dataValue + 1) }]) {
    const verdict = acceptRelayed(relayed({ message: { ...ask, data } }), PEERS)
    assert.equal(!verdict.ok && verdict.status, 400, JSON.stringify(data).slice(0, 40))
  }
})

test('data is capped in keys and in bytes', () => {
  const many = Object.fromEntries(Array.from({ length: RELAY_LIMITS.dataKeys + 1 }, (_, i) => [`k${i}`, 'v']))
  assert.equal(acceptRelayed(relayed({ message: { ...ask, data: many } }), PEERS).ok, false)

  const fat = Object.fromEntries(Array.from({ length: 4 }, (_, i) => [`k${i}`, 'x'.repeat(RELAY_LIMITS.dataValue)]))
  assert.ok(JSON.stringify(fat).length > RELAY_LIMITS.dataBytes)
  assert.equal(acceptRelayed(relayed({ message: { ...ask, data: fat } }), PEERS).ok, false)
})

test('the token bucket lets a burst through, refuses past it, and refills with the clock', () => {
  let now = 0
  const bucket = tokenBucket({ capacity: 3, refillMs: 60_000, now: () => now })

  assert.deepEqual([bucket.take(), bucket.take(), bucket.take(), bucket.take()], [true, true, true, false])
  now += 20_000 // a third of the window: one token back
  assert.equal(bucket.take(), true)
  assert.equal(bucket.take(), false)
  now += 10 * 60_000 // a long silence never fills it past its capacity
  assert.deepEqual([bucket.take(), bucket.take(), bucket.take(), bucket.take()], [true, true, true, false])
})

test('the relay defaults: 20 a minute, an 8 KiB body', () => {
  assert.equal(RELAY_RATE.capacity, 20)
  assert.equal(RELAY_RATE.refillMs, 60_000)
  assert.equal(RELAY_MAX_BODY_BYTES, 8 * 1024)
  assert.ok(RELAY_MAX_BODY_BYTES > MAX_PLAINTEXT_BYTES, 'any envelope the push cap allows fits in the body')
})
