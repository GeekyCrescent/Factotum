import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { eventually, manualClock, manualTimers } from '../test-support.ts'
import {
  BODY_CAP_BYTES,
  MAX_REDIRECTS,
  TIMEOUT_MS,
  USER_AGENT,
  createNet,
  isDeniedAddress,
  isLinkedIn,
  systemLookup,
  type FetchLike,
  type NetDeps,
} from './net.ts'

const POLITE_MS = 5_000
const PUBLIC_V4 = '93.184.216.34'

interface Call {
  readonly url: string
  readonly init: RequestInit
}

type Reply = Response | (() => Response | Promise<Response>)

/** A fetch that answers from a table and records what it was asked. No network. */
function fakeFetch(routes: Record<string, Reply>): { readonly fetch: FetchLike; readonly calls: Call[] } {
  const calls: Call[] = []
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init })
    const reply = routes[url]
    if (reply === undefined) throw new TypeError(`fetch failed: no route for ${url}`)
    return typeof reply === 'function' ? reply() : reply
  }
  return { fetch, calls }
}

function redirect(to: string, status = 301): Response {
  return new Response(null, { status, headers: { location: to } })
}

function harness(routes: Record<string, Reply>, dns: Record<string, readonly string[]> = {}, politeMs = POLITE_MS) {
  const timers = manualTimers()
  const clock = manualClock()
  const lookups: string[] = []
  const net = fakeFetch(routes)
  const deps: NetDeps = {
    fetch: net.fetch,
    lookup: async (hostname) => {
      lookups.push(hostname)
      return dns[hostname] ?? [PUBLIC_V4]
    },
    timers: timers.timers,
    now: clock.now,
    politeMs,
  }
  return { get: createNet(deps).get, calls: net.calls, lookups, timers, clock }
}

describe('isDeniedAddress', () => {
  const denied = [
    '127.0.0.1',
    '127.255.255.254',
    '10.0.0.1',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '100.127.255.255',
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    '0:0:0:0:0:0:0:1',
    'fc00::1',
    'fd7a:115c:a1e0::1',
    'fe80::1',
    'fe80::1%en0',
    'ff02::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:10.0.0.1',
    '::ffff:100.64.0.1',
    // Normalise first, check after (CLAUDE.md §2): its sixteen bytes are not zero.
    '::ffff:0.0.0.0',
    '::127.0.0.1',
    '64:ff9b::a9fe:a9fe',
    'not-an-address',
    '',
    // Special-purpose IPv4 (RFC 6890): IETF protocol, benchmarking, the three TEST-NETs, the old 6to4 relay.
    '192.0.0.8',
    '198.18.0.1',
    '198.19.255.255',
    '192.0.2.1',
    '198.51.100.7',
    '203.0.113.9',
    '192.88.99.1',
    // 6to4 embeds an IPv4 in bytes 2–5: unwrapped, then judged.
    '2002:7f00:1::1',
    '2002:a00:1::',
    '2002:a9fe:a9fe::1',
    '2001::1', // Teredo
    '2001:0:4136:e378:8000:63bf:3fff:fdd2',
    '64:ff9b:1::a00:1', // local-use NAT64
    '::ffff:0:7f00:1', // SIIT IPv4-translated
    '::ffff:0:808:808',
    'fec0::1', // deprecated site-local
    '2001:db8::1', // documentation
  ]
  for (const address of denied) {
    test(`denies ${JSON.stringify(address)}`, () => {
      assert.equal(isDeniedAddress(address), true)
    })
  }

  const allowed = [PUBLIC_V4, '8.8.8.8', '172.32.0.1', '100.128.0.1', '2606:4700::6810:85e5', '::ffff:8.8.8.8', '64:ff9b::808:808', '2002:808:808::1', '192.0.1.1', '198.20.0.1', '2001:4860::8888']
  for (const address of allowed) {
    test(`allows ${address}`, () => {
      assert.equal(isDeniedAddress(address), false)
    })
  }
})

describe('isLinkedIn', () => {
  test('matches the domain, its subdomains, a trailing dot and the shortener', () => {
    for (const host of ['linkedin.com', 'www.linkedin.com', 'au.LinkedIn.com', 'linkedin.com.', 'lnkd.in']) {
      assert.equal(isLinkedIn(host), true, host)
    }
  })
  test('does not match look-alikes', () => {
    for (const host of ['notlinkedin.com', 'linkedin.com.evil.example', 'linkedin.co']) {
      assert.equal(isLinkedIn(host), false, host)
    }
  })
})

describe('get', () => {
  test('fetches an https page with an honest User-Agent and manual redirects', async () => {
    const h = harness({ 'https://example.com/jobs': new Response('<h1>Jobs</h1>', { headers: { 'content-type': 'text/html' } }) })

    const result = await h.get('https://example.com/jobs')

    assert.deepEqual(result, {
      ok: true,
      value: { status: 200, url: 'https://example.com/jobs', redirects: [], contentType: 'text/html', body: '<h1>Jobs</h1>' },
    })
    assert.equal(USER_AGENT, 'factotum-jobs/0 (personal job search)')
    const init = h.calls[0]!.init
    assert.equal(new Headers(init.headers).get('user-agent'), USER_AGENT)
    assert.equal(init.redirect, 'manual')
    assert.ok(init.signal instanceof AbortSignal)
    assert.deepEqual(h.lookups, ['example.com'])
  })

  test('returns a 404 as a value, not an error', async () => {
    const h = harness({ 'https://example.com/gone': new Response('nope', { status: 404 }) })
    const result = await h.get('https://example.com/gone')
    assert.equal(result.ok && result.value.status, 404)
    assert.equal(result.ok && result.value.contentType, 'text/plain;charset=UTF-8')
  })

  test('refuses what is not a URL', async () => {
    const h = harness({})
    const result = await h.get('not a url')
    assert.deepEqual(result.ok ? null : result.error.kind, 'bad-url')
    assert.equal(result.ok ? null : result.error.code, 'invalid')
    assert.equal(h.calls.length, 0)
  })

  for (const url of ['http://example.com/', 'ftp://example.com/', 'file:///etc/passwd', 'javascript:alert(1)']) {
    test(`refuses ${url} without touching the network`, async () => {
      const h = harness({})
      const result = await h.get(url)
      assert.equal(result.ok ? null : result.error.kind, 'not-https')
      assert.equal(result.ok ? null : result.error.code, 'invalid')
      assert.equal(h.calls.length + h.lookups.length, 0)
    })
  }

  for (const url of ['https://example.com:8443/', 'https://example.com:80/', 'https://[::1]:8443/', 'https://example.com:22/']) {
    test(`refuses a port other than https's default: ${url}`, async () => {
      const h = harness({})
      const result = await h.get(url)
      assert.equal(result.ok ? null : result.error.kind, 'bad-url')
      assert.equal(result.ok ? null : result.error.code, 'invalid')
      assert.equal(h.calls.length + h.lookups.length, 0)
    })
  }

  test('allows the default port written out', async () => {
    const h = harness({ 'https://example.com/': new Response('hi') })
    const result = await h.get('https://example.com:443/')
    assert.equal(result.ok && result.value.body, 'hi')
  })

  test('refuses credentials in the URL', async () => {
    const h = harness({})
    const result = await h.get('https://user:pass@example.com/')
    assert.equal(result.ok ? null : result.error.kind, 'bad-url')
  })

  for (const url of ['https://www.linkedin.com/jobs/view/1', 'https://linkedin.com/', 'https://LINKEDIN.com./x', 'https://lnkd.in/abc']) {
    test(`refuses LinkedIn: ${url}`, async () => {
      const h = harness({})
      const result = await h.get(url)
      assert.equal(result.ok ? null : result.error.kind, 'linkedin')
      assert.equal(result.ok ? null : result.error.code, 'blocked')
      assert.equal(h.calls.length + h.lookups.length, 0)
    })
  }

  for (const url of ['https://127.0.0.1/', 'https://[::1]/', 'https://[::ffff:0.0.0.0]/', 'https://2130706433/', 'https://0x7f.1/', 'https://100.100.100.100/']) {
    test(`refuses an address literal in a private range: ${url}`, async () => {
      const h = harness({})
      const result = await h.get(url)
      assert.equal(result.ok ? null : result.error.kind, 'private-address')
      assert.equal(result.ok ? null : result.error.code, 'blocked')
      assert.equal(h.calls.length + h.lookups.length, 0)
    })
  }

  test('allows a public address literal without a lookup', async () => {
    const h = harness({ [`https://${PUBLIC_V4}/`]: new Response('hi') })
    const result = await h.get(`https://${PUBLIC_V4}/`)
    assert.equal(result.ok && result.value.body, 'hi')
    assert.deepEqual(h.lookups, [])
  })

  test('refuses a name that resolves to a private address', async () => {
    const h = harness({}, { 'intranet.example': ['100.101.102.103'] })
    const result = await h.get('https://intranet.example/')
    assert.equal(result.ok ? null : result.error.kind, 'private-address')
    assert.equal(h.calls.length, 0)
  })

  test('refuses a name when ANY of its addresses is private', async () => {
    const h = harness({}, { 'mixed.example': [PUBLIC_V4, '::ffff:192.168.0.1'] })
    const result = await h.get('https://mixed.example/')
    assert.equal(result.ok ? null : result.error.kind, 'private-address')
  })

  test('a name that resolves to nothing, or a failing lookup, is a dns error', async () => {
    const h = harness({}, { 'empty.example': [] })
    const empty = await h.get('https://empty.example/')
    assert.equal(empty.ok ? null : empty.error.kind, 'dns')

    const timers = manualTimers()
    const failing = createNet({
      fetch: fakeFetch({}).fetch,
      lookup: async () => {
        throw new Error('getaddrinfo ENOTFOUND')
      },
      timers: timers.timers,
      now: manualClock().now,
      politeMs: 0,
    })
    const result = await failing.get('https://nowhere.example/')
    assert.equal(result.ok ? null : result.error.kind, 'dns')
    assert.equal(result.ok ? null : result.error.code, 'module-error')
    assert.match(result.ok ? '' : result.error.reason, /ENOTFOUND/)
  })

  test('follows a redirect, re-checking and recording it', async () => {
    const h = harness({
      'https://www.seek.com.au/job/1': redirect('https://au.seek.com/job/1', 308),
      'https://au.seek.com/job/1': new Response('ad'),
    })
    const result = await h.get('https://www.seek.com.au/job/1')
    assert.deepEqual(result.ok && result.value.redirects, ['https://au.seek.com/job/1'])
    assert.equal(result.ok && result.value.url, 'https://au.seek.com/job/1')
    assert.deepEqual(h.lookups, ['www.seek.com.au', 'au.seek.com'])
  })

  test('resolves a relative Location against the current URL', async () => {
    const h = harness({
      'https://weworkremotely.com/remote-jobs/x': redirect('/', 301),
      'https://weworkremotely.com/': new Response('home'),
    })
    const pending = h.get('https://weworkremotely.com/remote-jobs/x')
    // A redirect to the same host is a second request to it: it waits its courtesy turn too.
    await eventually(() => h.timers.pending().includes(POLITE_MS), 'the redirect waits its turn')
    h.timers.fire(POLITE_MS)
    const result = await pending
    assert.equal(result.ok && result.value.url, 'https://weworkremotely.com/')
  })

  test('a redirect without a Location is returned as it is', async () => {
    const h = harness({ 'https://example.com/': new Response(null, { status: 302 }) })
    const result = await h.get('https://example.com/')
    assert.equal(result.ok && result.value.status, 302)
  })

  const badHops: ReadonlyArray<readonly [string, string, string]> = [
    ['http://example.com/', 'not-https', 'invalid'],
    ['https://www.linkedin.com/in/someone', 'linkedin', 'blocked'],
    ['https://169.254.169.254/latest/meta-data', 'private-address', 'blocked'],
    ['https://rebind.example/', 'private-address', 'blocked'],
    ['https://example.org:8080/', 'bad-url', 'invalid'],
  ]
  for (const [to, kind, code] of badHops) {
    test(`re-checks every redirect: refuses one to ${to}`, async () => {
      const h = harness({ 'https://example.com/': redirect(to, 302) }, { 'rebind.example': ['10.0.0.7'] })
      const result = await h.get('https://example.com/')
      assert.equal(result.ok ? null : result.error.kind, kind)
      assert.equal(result.ok ? null : result.error.code, code)
      assert.deepEqual(h.calls.map((call) => call.url), ['https://example.com/'])
    })
  }

  test('an allow() of the caller is asked before every hop, the first included, and a refused hop is never fetched', async () => {
    const h = harness({ 'https://a.example/': redirect('https://b.example/x'), 'https://b.example/x': new Response('b') })
    const asked: string[] = []
    const allow = (url: URL): boolean => {
      asked.push(url.href)
      return url.hostname === 'a.example'
    }
    const result = await h.get('https://a.example/', { allow })
    assert.equal(result.ok ? null : result.error.kind, 'not-allowed')
    assert.equal(result.ok ? null : result.error.code, 'blocked')
    assert.deepEqual(asked, ['https://a.example/', 'https://b.example/x'])
    assert.deepEqual(h.calls.map((call) => call.url), ['https://a.example/'])
    assert.deepEqual(h.lookups, ['a.example'])
    const first = await h.get('https://b.example/x', { allow })
    assert.equal(first.ok ? null : first.error.kind, 'not-allowed')
    assert.equal(h.calls.length, 1)
  })

  test(`follows ${MAX_REDIRECTS} redirects and refuses the next one`, async () => {
    assert.equal(MAX_REDIRECTS, 5)
    const routes: Record<string, Reply> = {}
    for (let i = 0; i <= MAX_REDIRECTS + 1; i += 1) routes[`https://h${i}.example/`] = redirect(`https://h${i + 1}.example/`)
    const h = harness(routes)

    const tooMany = await h.get('https://h0.example/')
    assert.equal(tooMany.ok ? null : tooMany.error.kind, 'too-many-redirects')
    assert.equal(tooMany.ok ? null : tooMany.error.code, 'limit')
    assert.equal(h.calls.length, MAX_REDIRECTS + 1)

    const fine = harness({ ...routes, [`https://h${MAX_REDIRECTS}.example/`]: new Response('end') })
    const result = await fine.get('https://h0.example/')
    assert.equal(result.ok && result.value.body, 'end')
    assert.equal(result.ok && result.value.redirects.length, MAX_REDIRECTS)
  })

  test('caps the body at 1 MiB while streaming', async () => {
    assert.equal(BODY_CAP_BYTES, 1024 * 1024)
    const chunk = new Uint8Array(256 * 1024).fill(97)
    let pulled = 0
    const endless = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull: (controller) => {
            pulled += 1
            controller.enqueue(chunk)
          },
        }),
      )
    const h = harness({ 'https://example.com/big': endless })
    const result = await h.get('https://example.com/big')
    assert.equal(result.ok ? null : result.error.kind, 'too-large')
    assert.equal(result.ok ? null : result.error.code, 'limit')
    assert.ok(pulled <= 6, `stopped reading early (${pulled} chunks)`)
  })

  test('a body of exactly 1 MiB passes', async () => {
    const h = harness({ 'https://example.com/max': new Response(new Uint8Array(BODY_CAP_BYTES).fill(98)) })
    const result = await h.get('https://example.com/max')
    assert.equal(result.ok && result.value.body.length, BODY_CAP_BYTES)
  })

  test('refuses up front when Content-Length is over the cap', async () => {
    let cancelled = false
    const h = harness({
      'https://example.com/declared': new Response(
        new ReadableStream({ pull: () => new Promise(() => {}), cancel: () => void (cancelled = true) }),
        { headers: { 'content-length': String(BODY_CAP_BYTES + 1) } },
      ),
    })
    const result = await h.get('https://example.com/declared')
    assert.equal(result.ok ? null : result.error.kind, 'too-large')
    assert.equal(cancelled, true)
  })

  test('times out after 20 s on the injected timers', async () => {
    assert.equal(TIMEOUT_MS, 20_000)
    let signal: AbortSignal | undefined
    const h = harness({})
    const hanging = createNet({
      fetch: (_url, init) => {
        signal = init.signal ?? undefined
        return new Promise(() => {})
      },
      lookup: async () => [PUBLIC_V4],
      timers: h.timers.timers,
      now: h.clock.now,
      politeMs: POLITE_MS,
    })
    const pending = hanging.get('https://slow.example/')
    await eventually(() => signal !== undefined, 'the fetch started')
    assert.deepEqual(h.timers.pending(), [TIMEOUT_MS])

    h.timers.fire(TIMEOUT_MS)
    const result = await pending
    assert.equal(result.ok ? null : result.error.kind, 'timeout')
    assert.equal(result.ok ? null : result.error.code, 'module-error')
    assert.equal(signal?.aborted, true)
  })

  test('the timeout also covers a lookup that never answers', async () => {
    const h = harness({})
    const hanging = createNet({
      fetch: fakeFetch({}).fetch,
      lookup: () => new Promise(() => {}),
      timers: h.timers.timers,
      now: h.clock.now,
      politeMs: POLITE_MS,
    })
    const pending = hanging.get('https://slow.example/')
    await eventually(() => h.timers.pending().includes(TIMEOUT_MS), 'the timeout is armed')
    h.timers.fire(TIMEOUT_MS)
    const result = await pending
    assert.equal(result.ok ? null : result.error.kind, 'timeout')
  })

  test('disarms the timeout once the page is read', async () => {
    const h = harness({ 'https://example.com/': new Response('ok') })
    await h.get('https://example.com/')
    assert.deepEqual(h.timers.pending(), [])
  })

  test('a transport failure is a network error, never a throw', async () => {
    const h = harness({
      'https://example.com/': () => {
        throw new TypeError('fetch failed')
      },
    })
    const result = await h.get('https://example.com/')
    assert.equal(result.ok ? null : result.error.kind, 'network')
    assert.equal(result.ok ? null : result.error.code, 'module-error')
    assert.match(result.ok ? '' : result.error.reason, /fetch failed/)
  })

  test('a body that breaks off half-way is a network error', async () => {
    const broken = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start: (controller) => {
            controller.enqueue(new Uint8Array([104, 105]))
            controller.error(new Error('socket hang up'))
          },
        }),
      )
    const h = harness({ 'https://example.com/': broken })
    const result = await h.get('https://example.com/')
    assert.equal(result.ok ? null : result.error.kind, 'network')
    assert.match(result.ok ? '' : result.error.reason, /socket hang up/)
  })

  test('the caller can abort, before or during the request', async () => {
    const h = harness({ 'https://example.com/': new Response('ok') })
    const before = await h.get('https://example.com/', { signal: AbortSignal.abort() })
    assert.equal(before.ok ? null : before.error.kind, 'aborted')
    assert.equal(h.calls.length, 0)

    const controller = new AbortController()
    const hanging = createNet({
      fetch: () => new Promise(() => {}),
      lookup: async () => [PUBLIC_V4],
      timers: h.timers.timers,
      now: h.clock.now,
      politeMs: 0,
    })
    const pending = hanging.get('https://example.com/', { signal: controller.signal })
    await eventually(() => h.timers.pending().includes(TIMEOUT_MS), 'the request started')
    controller.abort()
    const during = await pending
    assert.equal(during.ok ? null : during.error.kind, 'aborted')
  })
})

describe('courtesy per host', () => {
  test('the first request to a host goes at once; the next waits politeMs after the last one ended', async () => {
    const h = harness({ 'https://example.com/a': () => new Response('a'), 'https://example.com/b': () => new Response('b') })

    const first = await h.get('https://example.com/a')
    assert.equal(first.ok, true)
    assert.deepEqual(h.timers.pending(), [])

    h.clock.advance(1_000)
    const second = h.get('https://example.com/b')
    await eventually(() => h.timers.pending().includes(POLITE_MS - 1_000), 'the courtesy wait is armed')
    assert.equal(h.calls.length, 1)

    h.clock.advance(POLITE_MS - 1_000)
    h.timers.fire(POLITE_MS - 1_000)
    const result = await second
    assert.equal(result.ok && result.value.body, 'b')
    assert.equal(h.calls.length, 2)
  })

  test('no wait once politeMs has already passed', async () => {
    const h = harness({ 'https://example.com/a': () => new Response('a') })
    await h.get('https://example.com/a')
    h.clock.advance(POLITE_MS)
    await h.get('https://example.com/a')
    assert.equal(h.calls.length, 2)
  })

  test('requests to one host go in series; other hosts are not held up', async () => {
    const h = harness({
      'https://a.example/1': () => new Response('1'),
      'https://a.example/2': () => new Response('2'),
      'https://b.example/': () => new Response('b'),
    })
    const one = h.get('https://a.example/1')
    const two = h.get('https://a.example/2')
    const other = await h.get('https://b.example/')
    assert.equal(other.ok, true)

    assert.equal((await one).ok, true)
    await eventually(() => h.timers.pending().includes(POLITE_MS), 'the second request waits its turn')
    assert.deepEqual(h.calls.map((call) => call.url).sort(), ['https://a.example/1', 'https://b.example/'])

    h.timers.fire(POLITE_MS)
    assert.equal((await two).ok, true)
  })

  test('the caller\'s signal cuts the courtesy wait short, and disarms its timer', async () => {
    const h = harness({ 'https://example.com/a': () => new Response('a') })
    await h.get('https://example.com/a')
    const controller = new AbortController()
    const waiting = h.get('https://example.com/a', { signal: controller.signal })
    await eventually(() => h.timers.pending().includes(POLITE_MS), 'the courtesy wait is armed')
    controller.abort()
    const result = await waiting
    assert.equal(result.ok ? null : result.error.kind, 'aborted')
    assert.deepEqual(h.timers.pending(), [])
    assert.equal(h.calls.length, 1)
  })

  test('a caller waiting for a request still in flight can give up, and the next one still waits for that request', async () => {
    let finish: (response: Response) => void = () => undefined
    const h = harness({ 'https://example.com/slow': () => new Promise<Response>((resolve) => (finish = resolve)), 'https://example.com/next': () => new Response('next') }, {}, 0)
    const slow = h.get('https://example.com/slow')
    await eventually(() => h.calls.length === 1, 'the slow request is in flight')
    const controller = new AbortController()
    const giving = h.get('https://example.com/next', { signal: controller.signal })
    controller.abort()
    const gaveUp = await giving
    assert.equal(gaveUp.ok ? null : gaveUp.error.kind, 'aborted')
    const next = h.get('https://example.com/next')
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(h.calls.length, 1, 'still one request at a time to the host')
    finish(new Response('slow'))
    assert.equal((await slow).ok, true)
    assert.equal((await next).ok, true)
    assert.equal(h.calls.length, 2)
  })

  test('a request that throws after losing to the deadline is observed, not an unhandled rejection', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => void unhandled.push(reason)
    process.on('unhandledRejection', onUnhandled)
    try {
      // A Response that is not one: reading its headers throws inside the request, after fetch.
      const notAResponse = { status: 200, headers: null } as unknown as Response
      let breakIt: () => void = () => undefined
      const fetch: FetchLike = () => new Promise<Response>((resolve) => (breakIt = () => resolve(notAResponse)))
      const timers = manualTimers()
      const broken: FetchLike = async () => notAResponse
      const net = createNet({ fetch, lookup: async () => [PUBLIC_V4], timers: timers.timers, now: manualClock().now, politeMs: 0 })
      const controller = new AbortController()
      const pending = net.get('https://example.com/', { signal: controller.signal })
      await eventually(() => timers.pending().includes(TIMEOUT_MS), 'the request started')
      controller.abort()
      assert.equal((await pending).ok, false)
      const brokenNet = createNet({ fetch: broken, lookup: async () => [PUBLIC_V4], timers: timers.timers, now: manualClock().now, politeMs: 0 })
      const thrown = await brokenNet.get('https://example.com/')
      assert.equal(thrown.ok ? null : thrown.error.kind, 'network')
      breakIt()
      await new Promise((resolve) => setTimeout(resolve, 20))
      assert.deepEqual(unhandled, [])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  test('a failed request still frees the turn', async () => {
    const h = harness({}, { 'a.example': [] }, 0)
    const first = await h.get('https://a.example/')
    const second = await h.get('https://a.example/')
    assert.equal(first.ok || second.ok, false)
  })
})

describe('systemLookup', () => {
  test('resolves an address literal without the network', async () => {
    assert.deepEqual(await systemLookup('127.0.0.1'), ['127.0.0.1'])
  })
})
