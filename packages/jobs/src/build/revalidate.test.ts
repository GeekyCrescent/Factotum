import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { BODY_CAP_BYTES, createNet, type FetchLike, type Net } from '../scout/net.ts'
import { openDb, type Db, type Queries } from '../store/db.ts'
import * as repo from '../store/repo.ts'
import { application, errorOf, NOW, valueOf } from '../test-state.ts'
import { assertLinearTime, manualClock, manualTimers, tempBase, type TempBase } from '../test-support.ts'
import { ok, type Application, type Opportunity, type Warning } from '../types.ts'
import { AD_STALE_MS, classifyAd, revalidateAd } from './revalidate.ts'

const HOUR_MS = 3_600_000
const hoursAgo = (hours: number): string => new Date(NOW.getTime() - hours * HOUR_MS).toISOString()

type Route = string | Response | Error

function netOf(routes: Record<string, Route>): { readonly net: Net; readonly asked: string[] } {
  const asked: string[] = []
  const fetch: FetchLike = async (url) => {
    asked.push(url)
    const route = routes[url]
    if (route === undefined) return new Response('nope', { status: 404 })
    if (route instanceof Error) throw route
    return typeof route === 'string' ? new Response(route, { status: 200 }) : route
  }
  const net = createNet({ fetch, lookup: async () => ['93.184.216.34'], timers: manualTimers().timers, now: manualClock(NOW).now, politeMs: 0 })
  return { net, asked }
}

const SEEK = 'https://au.seek.com/job/81234567'
const redux = (job: Record<string, unknown>): string =>
  `<html><script>window.SEEK_REDUX_DATA = ${JSON.stringify({ jobdetails: { result: { job } } })};</script><body>…</body></html>`

const verdictOf = async (url: string, routes: Record<string, Route>) => {
  const { net } = netOf(routes)
  return classifyAd(url, await net.get(url))
}

describe('classifyAd (N3, design D9 «El anuncio vivo», markers of A6)', () => {
  test('404 and 410 are closed (Greenhouse, Lever, YC)', async () => {
    const url = 'https://boards.greenhouse.io/acme/jobs/1'
    assert.deepEqual(await verdictOf(url, { [url]: new Response('{"status":404,"error":"Job not found"}', { status: 404 }) }), { kind: 'closed', reason: 'http-404' })
    assert.deepEqual(await verdictOf(url, { [url]: new Response('', { status: 410 }) }), { kind: 'closed', reason: 'http-410' })
  })

  test('SEEK closed stays 200: isExpired or status "Expired" in SEEK_REDUX_DATA', async () => {
    assert.deepEqual(await verdictOf(SEEK, { [SEEK]: redux({ id: '1', isExpired: true, status: 'Expired' }) }), { kind: 'closed', reason: 'seek-expired' })
    assert.deepEqual(await verdictOf(SEEK, { [SEEK]: redux({ id: '1', isExpired: false, status: 'Expired' }) }), { kind: 'closed', reason: 'seek-expired' })
  })

  test('SEEK open: the parsed job wins over the later markers', async () => {
    const page = `${redux({ id: '1', isExpired: false, status: 'Active' })} This job is no longer advertised`
    assert.deepEqual(await verdictOf(SEEK, { [SEEK]: page }), { kind: 'open' })
  })

  test('SEEK without a parseable SEEK_REDUX_DATA: data-automation="expiredJobPage", else the visible text', async () => {
    const broken = '<script>window.SEEK_REDUX_DATA = {"jobdetails": undefined-ish;</script>'
    assert.deepEqual(await verdictOf(SEEK, { [SEEK]: `${broken}<div data-automation="expiredJobPage">gone</div>` }), { kind: 'closed', reason: 'seek-expired-page' })
    assert.deepEqual(await verdictOf(SEEK, { [SEEK]: '<h2>This job is no longer advertised</h2>' }), { kind: 'closed', reason: 'seek-no-longer-advertised' })
    assert.deepEqual(await verdictOf(SEEK, { [SEEK]: redux({ id: '1' }).replace('"job"', '"other"') }), { kind: 'open' })
    assert.deepEqual(await verdictOf(SEEK, { [SEEK]: '<h1>Graduate developer</h1>' }), { kind: 'open' })
  })

  test('a hostile 1 MiB SEEK page is read in linear time (the regexes run synchronously)', async () => {
    const full = BODY_CAP_BYTES - 64
    const fill = (size: number, unit: string, tail = ''): string =>
      unit.repeat(Math.floor((size - tail.length) / unit.length)) + tail
    const bodies: readonly ((size: number) => string)[] = [
      (size) => `SEEK_REDUX_DATA${fill(size, ' ')}`,
      (size) => fill(size, 'SEEK_REDUX_DATA = {'),
      (size) => `SEEK_REDUX_DATA = ${fill(size, '{"a":"\\"')}`,
      (size) => fill(size, 'data-automation = '),
      (size) => `data-automation${fill(size, ' ', '=')}`,
      (size) => fill(size, 'this job is no longer '),
    ]
    for (const body of bodies) {
      await assertLinearTime(body(64).slice(0, 20), full, (size) => verdictOf(SEEK, { [SEEK]: body(size) }))
    }
  })

  test('a host written with the root dot is still SEEK / We Work Remotely', () => {
    const expired = redux({ id: '1', isExpired: true })
    const seekPage = { status: 200, url: 'https://au.seek.com./job/1', redirects: [], contentType: 'text/html', body: expired }
    assert.deepEqual(classifyAd('https://au.seek.com./job/1', { ok: true, value: seekPage }), { kind: 'closed', reason: 'seek-expired' })
    const wwrPage = { status: 200, url: 'https://weworkremotely.com./', redirects: ['https://weworkremotely.com./'], contentType: 'text/html', body: '' }
    assert.deepEqual(classifyAd('https://weworkremotely.com./remote-jobs/x', { ok: true, value: wwrPage }), { kind: 'closed', reason: 'redirected-home' })
  })

  test('the SEEK markers are SEEK\'s: the same text elsewhere is an open page', async () => {
    const url = 'https://acme.example/jobs/1'
    assert.deepEqual(await verdictOf(url, { [url]: '<p>This job is no longer advertised</p>' }), { kind: 'open' })
  })

  test('We Work Remotely: a 301 to the home page is closed; the ad itself is open', async () => {
    const url = 'https://weworkremotely.com/remote-jobs/acme-junior-dev'
    const home = 'https://weworkremotely.com/'
    assert.deepEqual(
      await verdictOf(url, { [url]: new Response(null, { status: 301, headers: { location: home } }), [home]: '<h1>We Work Remotely</h1>' }),
      { kind: 'closed', reason: 'redirected-home' },
    )
    assert.deepEqual(await verdictOf(url, { [url]: '<h1>Junior dev</h1>' }), { kind: 'open' })
  })

  test('no answer, a refusal or a server error is not a verdict', async () => {
    const url = 'https://acme.example/jobs/1'
    assert.deepEqual(await verdictOf(url, { [url]: new TypeError('socket hang up') }), { kind: 'unreachable', reason: 'network' })
    assert.deepEqual(await verdictOf(url, { [url]: new Response('', { status: 403 }) }), { kind: 'unreachable', reason: 'http-403' })
    assert.deepEqual(await verdictOf(url, { [url]: new Response('', { status: 503 }) }), { kind: 'unreachable', reason: 'http-503' })
  })
})

// ── On the store ─────────────────────────────────────────────────────────────────────────────────

const AD = 'https://boards.greenhouse.io/acme/jobs/1'

const vacancy = (overrides: Partial<Opportunity> = {}): Opportunity => ({
  id: 'opp-1',
  companyId: 'company-1',
  kind: 'vacancy',
  title: 'Graduate engineer',
  goalId: null,
  url: AD,
  postedAt: null,
  closesAt: null,
  startsAt: null,
  duration: null,
  hours: null,
  salary: null,
  requirements: '',
  score: 80,
  breakdown: null,
  profileVersion: null,
  source: 'seed',
  sourceRef: null,
  remote: null,
  status: 'open',
  discardReason: null,
  checkedAt: null,
  ...overrides,
})

const write = <T>(db: Db, fn: (q: Queries) => T): T => valueOf(db.tx((q) => ok(fn(q))))

async function store(base: TempBase, opp: Partial<Opportunity> = {}, app: Partial<Application> = {}): Promise<Db> {
  const db = valueOf(await openDb({ dir: base.dir, now: () => NOW }))
  write(db, (q) => {
    const company = { id: 'company-1', name: 'Acme', nameKey: 'acme', domain: null, website: null, careersUrl: null, linkedin: null, sector: null, size: null, location: null, isHealthEmployer: false, healthSource: null, ats: null, record: '' }
    repo.insertCompany(q, company, { kind: 'imported' }, NOW)
    repo.insertOpportunity(q, vacancy(opp), 'acme|grad', { kind: 'imported' }, NOW)
    repo.insertApplication(q, application({ id: 'app-1', channel: 'form', target: { ...application().target, contactId: null }, state: 'ready', ...app }), { seedKey: null }, { kind: 'imported' }, NOW)
  })
  return db
}

const read = (db: Db) => db.read((q) => ({ app: repo.getApplication(q, 'app-1'), opp: repo.getOpportunity(q, 'opp-1') }))
const adEvents = (db: Db) =>
  db.read((q) => q.all<{ application_id: string | null; data: string }>("SELECT application_id, data FROM events WHERE kind = 'ad-checked' ORDER BY rowid")).map((e) => ({
    applicationId: e.application_id,
    ...(JSON.parse(e.data) as Record<string, unknown>),
  }))

describe('revalidateAd (N3 on the store)', () => {
  test('a closed ad → ad-closed (blocks, Skip proposed), ready → in-review, the opportunity closed and checked', async () => {
    using base = tempBase()
    const db = await store(base)
    const { net } = netOf({ [AD]: new Response('', { status: 404 }) })
    const outcome = valueOf(await revalidateAd({ db, net, now: () => NOW }, 'app-1'))
    assert.deepEqual(outcome.verdict, { kind: 'closed', reason: 'http-404' })
    const { app, opp } = read(db)
    assert.equal(app?.state, 'in-review')
    const expected: Warning = { code: 'ad-closed', where: 'ad', detail: 'the ad is closed (http-404): skip it?', blocks: true, overridden: null }
    assert.deepEqual(app?.warnings, [expected])
    assert.deepEqual([opp?.status, opp?.checkedAt], ['closed', NOW.toISOString()])
    assert.deepEqual(adEvents(db), [
      { applicationId: null, closed: true, reason: 'http-404', opportunityId: 'opp-1' },
      { applicationId: 'app-1', closed: true, reason: 'http-404', from: 'ready', to: 'in-review' },
    ])
    db.close()
  })

  test('an open ad only moves checkedAt; the application is untouched', async () => {
    using base = tempBase()
    const db = await store(base, { checkedAt: hoursAgo(25) })
    const outcome = valueOf(await revalidateAd({ db, net: netOf({ [AD]: '<h1>Graduate engineer</h1>' }).net, now: () => NOW }, 'app-1'))
    assert.deepEqual(outcome.verdict, { kind: 'open' })
    const { app, opp } = read(db)
    assert.deepEqual([app?.state, app?.warnings], ['ready', []])
    assert.deepEqual([opp?.status, opp?.checkedAt], ['open', NOW.toISOString()])
    assert.deepEqual(adEvents(db), [{ applicationId: null, closed: false, reason: 'open', opportunityId: 'opp-1' }])
    db.close()
  })

  test('only when the last check is older than 24 h', async () => {
    using base = tempBase()
    const db = await store(base, { checkedAt: hoursAgo(23) })
    const { net, asked } = netOf({ [AD]: new Response('', { status: 404 }) })
    assert.equal(AD_STALE_MS, 24 * HOUR_MS)
    assert.deepEqual(valueOf(await revalidateAd({ db, net, now: () => NOW }, 'app-1')), { checked: false, why: 'fresh', verdict: null })
    assert.deepEqual(asked, [])
    assert.equal(read(db).app?.state, 'ready')
    db.close()
  })

  test('no network: checkedAt moves (the next try is in 24 h), nothing closes', async () => {
    using base = tempBase()
    const db = await store(base)
    const outcome = valueOf(await revalidateAd({ db, net: netOf({ [AD]: new TypeError('down') }).net, now: () => NOW }, 'app-1'))
    assert.deepEqual(outcome.verdict, { kind: 'unreachable', reason: 'network' })
    const { app, opp } = read(db)
    assert.deepEqual([app?.state, opp?.status, opp?.checkedAt], ['ready', 'open', NOW.toISOString()])
    db.close()
  })

  test('an ad-closed already there (even overridden) is not added twice', async () => {
    using base = tempBase()
    const overridden: Warning = { code: 'ad-closed', where: 'ad', detail: 'x', blocks: true, overridden: { at: hoursAgo(30) } }
    const db = await store(base, { checkedAt: hoursAgo(30) }, { warnings: [overridden] })
    valueOf(await revalidateAd({ db, net: netOf({ [AD]: new Response('', { status: 410 }) }).net, now: () => NOW }, 'app-1'))
    assert.deepEqual(read(db).app?.warnings, [overridden])
    assert.equal(read(db).app?.state, 'ready')
    db.close()
  })

  test('nothing to check: not a vacancy, no url, already closed, not in review, or no such application', async () => {
    const cases: readonly [Partial<Opportunity>, Partial<Application>, string][] = [
      [{ kind: 'outreach' }, {}, 'not-a-vacancy'],
      [{ url: null }, {}, 'no-url'],
      [{ status: 'closed' }, {}, 'closed'],
      [{}, { state: 'draft' }, 'not-in-review'],
    ]
    for (const [opp, app, why] of cases) {
      using base = tempBase()
      const db = await store(base, opp, app)
      const { net, asked } = netOf({})
      assert.deepEqual(valueOf(await revalidateAd({ db, net, now: () => NOW }, 'app-1')), { checked: false, why, verdict: null })
      assert.deepEqual(asked, [])
      db.close()
    }
    using base = tempBase()
    const db = await store(base)
    errorOf(await revalidateAd({ db, net: netOf({}).net, now: () => NOW }, 'nope'), 'not-found')
    db.close()
  })

  test('an application that left review while the page was read is not moved', async () => {
    using base = tempBase()
    const db = await store(base)
    const { net } = netOf({})
    const moving: Net = {
      get: async (url, options) => {
        write(db, (q) => q.run("UPDATE applications SET state = 'approved' WHERE id = 'app-1'"))
        return net.get(url, options)
      },
    }
    const outcome = valueOf(await revalidateAd({ db, net: moving, now: () => NOW }, 'app-1'))
    assert.deepEqual(outcome.verdict, { kind: 'closed', reason: 'http-404' })
    const { app, opp } = read(db)
    assert.deepEqual([app?.state, app?.warnings, opp?.status], ['approved', [], 'closed'])
    db.close()
  })
})
