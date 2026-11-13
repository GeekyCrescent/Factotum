import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { BODY_CAP_BYTES, createNet, type FetchLike, type Net } from '../scout/net.ts'
import { openDb, type Db } from '../store/db.ts'
import * as repo from '../store/repo.ts'
import { ADDRESSES, application, contact, NOW, valueOf, errorOf } from '../test-state.ts'
import { assertLinearTime, manualClock, manualTimers, tempBase, type TempBase } from '../test-support.ts'
import { ok, type Address, type Opportunity } from '../types.ts'
import { addressSearch, applyAddressOutcome, checkAddress, MAX_EXTRA_PAGES, searchAddress, type AddressOutcome } from './address.ts'

const EMAIL = 'ada@acme.example'
/** Generous for linear work on 1 MiB, even under coverage; the quadratic regexes took seconds. */
const HOME = 'https://acme.example/'

type Route = string | { readonly status: number; readonly body?: string } | Error

/** A `fetch` that answers from a table and records what it was asked. No network. */
function fakeFetch(routes: Record<string, Route>): { readonly fetch: FetchLike; readonly asked: string[] } {
  const asked: string[] = []
  const fetch: FetchLike = async (url) => {
    asked.push(url)
    const route = routes[url]
    if (route === undefined) return new Response('not here', { status: 404 })
    if (route instanceof Error) throw route
    if (typeof route === 'string') return new Response(route, { status: 200, headers: { 'content-type': 'text/html' } })
    return new Response(route.body ?? '', { status: route.status })
  }
  return { fetch, asked }
}

function netOf(routes: Record<string, Route>): { readonly net: Net; readonly asked: string[] } {
  const { fetch, asked } = fakeFetch(routes)
  const net = createNet({ fetch, lookup: async () => ['93.184.216.34'], timers: manualTimers().timers, now: manualClock().now, politeMs: 0 })
  return { net, asked }
}

const page = (body: string, links: readonly string[] = []): string =>
  `<html><body>${links.map((href) => `<a href="${href}">${href}</a>`).join(' ')}<p>${body}</p></body></html>`

const search = (routes: Record<string, Route>, website: string | null = HOME, email = EMAIL) => searchAddress(netOf(routes).net, { email, website })

describe('searchAddress (N2, design D9 «La re-búsqueda»)', () => {
  test('finds the address written literally on the home page', async () => {
    assert.deepEqual(await search({ [HOME]: page(`Write to ${EMAIL} today`) }), { kind: 'found', url: HOME })
  })

  test('finds it in a mailto: link, also URL-encoded', async () => {
    assert.deepEqual(await search({ [HOME]: '<a href="mailto:ada%40acme.example?subject=Hi">Email us</a>' }), { kind: 'found', url: HOME })
  })

  test('finds it obfuscated with [at] or « at », and with an HTML entity for @', async () => {
    for (const written of ['ada [at] acme.example', 'ada at acme.example', 'ada(at)acme.example', 'ada&#64;acme.example', 'ADA@ACME.example']) {
      assert.deepEqual(await search({ [HOME]: page(`Contact: ${written}.`) }), { kind: 'found', url: HOME }, written)
    }
  })

  test('does not take a longer address that merely contains it', async () => {
    const outcome = await search({ [HOME]: page('Write to lada@acme.example or ada@acme.example.au') })
    assert.deepEqual(outcome, { kind: 'not-found' })
  })

  test('follows up to six contact|careers|jobs|about|team|join pages of the domain and its subdomains', async () => {
    const links = [
      '/blog',
      '/about',
      'https://careers.acme.example/jobs',
      'https://other.example/contact',
      'http://acme.example/team',
      '/contact-us',
      '/our-team',
      '/join',
      '/about', // repeated
      '/careers',
      '/jobs/backend',
    ]
    const { net, asked } = netOf({
      [HOME]: page('Welcome', links),
      'https://acme.example/jobs/backend': page(`Apply: ${EMAIL}`),
    })
    const outcome = await searchAddress(net, { email: EMAIL, website: HOME })
    assert.equal(MAX_EXTRA_PAGES, 6)
    // Six pages at most: the seventh candidate (`/jobs/backend`, which has it) is never fetched.
    assert.deepEqual(outcome, { kind: 'not-found' })
    assert.deepEqual(asked, [
      HOME,
      'https://acme.example/about',
      'https://careers.acme.example/jobs',
      'https://acme.example/contact-us',
      'https://acme.example/our-team',
      'https://acme.example/join',
      'https://acme.example/careers',
    ])
  })

  test('a link counts by its text too, and the search stops at the first page that has it', async () => {
    const { net, asked } = netOf({
      [HOME]: '<a href="/p/42">Get in touch</a> <a href="/x">Contact</a> <a href="/careers">Careers</a>',
      'https://acme.example/x': page(`hello ${EMAIL}`),
    })
    assert.deepEqual(await searchAddress(net, { email: EMAIL, website: HOME }), { kind: 'found', url: 'https://acme.example/x' })
    assert.deepEqual(asked, [HOME, 'https://acme.example/x'])
  })

  test('the domain is the website without www., and a redirect off the domain does not count', async () => {
    const { net, asked } = netOf({
      'https://www.acme.example/': page('home', ['https://acme.example/contact', 'https://jobs.acme.example/']),
      'https://acme.example/contact': { status: 302, body: '' },
      'https://jobs.acme.example/': page(`jobs: ${EMAIL}`),
    })
    const outcome = await searchAddress(net, { email: EMAIL, website: 'https://www.acme.example' })
    assert.deepEqual(outcome, { kind: 'found', url: 'https://jobs.acme.example/' })
    assert.ok(asked.includes('https://acme.example/contact'))
  })

  test('a page that lands off the domain after redirects is not searched', async () => {
    const { fetch } = fakeFetch({
      [HOME]: page('home', ['/contact']),
      'https://hosted.example/contact': page(`${EMAIL}`),
    })
    const redirecting: FetchLike = async (url, init) =>
      url === 'https://acme.example/contact' ? new Response(null, { status: 301, headers: { location: 'https://hosted.example/contact' } }) : fetch(url, init)
    const asked: string[] = []
    const recording: FetchLike = async (url, init) => {
      asked.push(url)
      return redirecting(url, init)
    }
    const net = createNet({ fetch: recording, lookup: async () => ['93.184.216.34'], timers: manualTimers().timers, now: manualClock().now, politeMs: 0 })
    assert.deepEqual(await searchAddress(net, { email: EMAIL, website: HOME }), { kind: 'not-found' })
    assert.deepEqual(asked, [HOME, 'https://acme.example/contact'], 'the off-domain hop is never fetched')
  })

  test('a home page that redirects off the domain is not-found, and the other site is never fetched', async () => {
    const asked: string[] = []
    const fetch: FetchLike = async (url) => {
      asked.push(url)
      return url === HOME ? new Response(null, { status: 301, headers: { location: 'https://parked.example/' } }) : new Response(EMAIL)
    }
    const net = createNet({ fetch, lookup: async () => ['93.184.216.34'], timers: manualTimers().timers, now: manualClock().now, politeMs: 0 })
    assert.deepEqual(await searchAddress(net, { email: EMAIL, website: HOME }), { kind: 'not-found' })
    assert.deepEqual(asked, [HOME])
  })

  test('a sub-page that fails or is not 2xx is skipped', async () => {
    const outcome = await search({
      [HOME]: page('home', ['/contact', '/about']),
      'https://acme.example/contact': new TypeError('socket hang up'),
      'https://acme.example/about': { status: 500, body: EMAIL },
    })
    assert.deepEqual(outcome, { kind: 'not-found' })
  })

  test('no website → no-website; no network or a home page that is not 2xx → unreachable («couldn\'t check»)', async () => {
    assert.deepEqual(await search({}, null), { kind: 'no-website' })
    assert.deepEqual(await search({}, 'not a url'), { kind: 'no-website' })
    assert.deepEqual(await search({ [HOME]: new TypeError('getaddrinfo ENOTFOUND') }), { kind: 'unreachable', reason: 'network' })
    assert.deepEqual(await search({ [HOME]: { status: 503 } }), { kind: 'unreachable', reason: 'http-503' })
  })

  test('a cancelled search stops before the next page', async () => {
    const controller = new AbortController()
    const { fetch, asked } = fakeFetch({ [HOME]: page('home', ['/contact']) })
    const aborting: FetchLike = async (url, init) => {
      const response = await fetch(url, init)
      controller.abort()
      return response
    }
    const net = createNet({ fetch: aborting, lookup: async () => ['93.184.216.34'], timers: manualTimers().timers, now: manualClock().now, politeMs: 0 })
    assert.deepEqual(await searchAddress(net, { email: EMAIL, website: HOME }, controller.signal), { kind: 'unreachable', reason: 'aborted' })
    assert.deepEqual(asked, [HOME])
  })

  describe('reads a hostile 1 MiB page in linear time (the 60 s deadline cannot interrupt a regex)', () => {
    const full = BODY_CAP_BYTES - 64
    const fill = (size: number, unit: string, tail = ''): string =>
      unit.repeat(Math.floor((size - tail.length) / unit.length)) + tail
    const bodies: Readonly<Record<string, (size: number) => string>> = {
      'unclosed tags': (size) => fill(size, '<'),
      'anchors that never close': (size) => fill(size, '<a href="x">'),
      'anchors sharing one far </a>': (size) => fill(size, '<a href="/contact">', '</a>'),
      'a whitespace run': (size) => `ada${fill(size, ' ', 'acme.example')}`,
      'a whitespace run before a bracket': (size) => fill(size, ' ', '['),
      'an unclosed href': (size) => fill(size, '<a href="', '>'),
      'nested-looking entities': (size) => fill(size, '&#1'),
    }
    for (const [name, body] of Object.entries(bodies)) {
      test(name, async () => {
        await assertLinearTime(name, full, (size) => search({ [HOME]: body(size) }))
        assert.notEqual((await search({ [HOME]: body(full) })).kind, 'found')
      })
    }
  })

  test('decodes numeric entities, and leaves out-of-range ones as text instead of throwing', async () => {
    assert.deepEqual(await search({ [HOME]: page('ada&#x40;acme.example') }), { kind: 'found', url: HOME })
    for (const bad of ['&#99999999999;', '&#x110000;', '&#xD800;', '&#55296;', '&#xFFFFFFFFFFFFFFFFFFFF;']) {
      assert.deepEqual(await search({ [HOME]: page(`${bad} ${EMAIL}`) }), { kind: 'found', url: HOME }, bad)
    }
  })

  test('an anchor whose link text is cut by the next anchor still counts by its own text', async () => {
    const { net, asked } = netOf({
      [HOME]: '<a href="/p/1">Contact<a href="/p/2">nothing here</a><A HREF=\'/p/3\' class="x">Our <b>team</b></A>',
      'https://acme.example/p/3': page(EMAIL),
    })
    assert.deepEqual(await searchAddress(net, { email: EMAIL, website: HOME }), { kind: 'found', url: 'https://acme.example/p/3' })
    assert.deepEqual(asked, [HOME, 'https://acme.example/p/1', 'https://acme.example/p/3'])
  })

  test('addressSearch binds a Net', async () => {
    const { net } = netOf({ [HOME]: page(EMAIL) })
    assert.deepEqual(await addressSearch(net)({ email: EMAIL, website: HOME }), { kind: 'found', url: HOME })
  })
})

// ── Writing the result (T-D3, T-D4) ──────────────────────────────────────────────────────────────

const opportunity: Opportunity = {
  id: 'opp-1',
  companyId: 'company-1',
  kind: 'outreach',
  title: 'Outreach',
  goalId: null,
  url: null,
  postedAt: null,
  closesAt: null,
  startsAt: null,
  duration: null,
  hours: null,
  salary: null,
  requirements: '',
  score: null,
  breakdown: null,
  profileVersion: null,
  source: 'seed',
  sourceRef: null,
  remote: null,
  status: 'open',
  discardReason: null,
  checkedAt: null,
}

async function store(base: TempBase, address: Address, website: string | null = HOME): Promise<Db> {
  const db = valueOf(await openDb({ dir: base.dir, now: () => NOW }))
  valueOf(
    db.tx((q) => {
      const company = { id: 'company-1', name: 'Acme', nameKey: 'acme', domain: 'acme.example', website, careersUrl: null, linkedin: null, sector: null, size: null, location: null, isHealthEmployer: false, healthSource: null, ats: null, record: '' }
      repo.insertCompany(q, company, { kind: 'imported' }, NOW)
      repo.insertContact(q, contact(address), { kind: 'imported' }, NOW)
      repo.insertOpportunity(q, opportunity, 'acme|outreach', { kind: 'imported' }, NOW)
      repo.insertApplication(q, application({ id: 'app-1', state: 'in-review' }), { seedKey: 'pkg#1' }, { kind: 'imported' }, NOW)
      repo.insertApplication(q, application({ id: 'app-2', state: 'ready' }), { seedKey: 'pkg#2' }, { kind: 'imported' }, NOW)
      return ok(undefined)
    }),
  )
  return db
}

const contactOf = (db: Db) => db.read((q) => repo.getContact(q, 'contact-1'))
const addressEvents = (db: Db) =>
  db.read((q) => q.all<{ data: string }>("SELECT data FROM events WHERE kind = 'address-checked' ORDER BY rowid").map((row) => JSON.parse(row.data) as Record<string, unknown>))

describe('applyAddressOutcome / checkAddress (N2 → Contact.address)', () => {
  test('found → verified with verifiedUrl and checkedAt (T-D3), event address-checked { found, url }', async () => {
    using base = tempBase()
    const db = await store(base, ADDRESSES.checking)
    const moved = valueOf(db.tx((q) => applyAddressOutcome(q, 'contact-1', { kind: 'found', url: 'https://acme.example/contact' }, NOW)))
    assert.deepEqual(moved.address, { status: 'verified', verifiedUrl: 'https://acme.example/contact', checkedAt: NOW.toISOString(), override: null })
    assert.deepEqual(contactOf(db)?.address, moved.address)
    assert.deepEqual(addressEvents(db).at(-1), { found: true, url: 'https://acme.example/contact', contactId: 'contact-1' })
    db.close()
  })

  test('not found, no website, unreachable or timed out → unverified with checkedAt (T-D4)', async () => {
    const cases: readonly [AddressOutcome, Record<string, unknown>][] = [
      [{ kind: 'not-found' }, { found: false, reason: 'not-found' }],
      [{ kind: 'no-website' }, { found: false, reason: 'no-website' }],
      [{ kind: 'unreachable', reason: 'network' }, { found: false, reason: 'unreachable', detail: 'network' }],
      [{ kind: 'timed-out' }, { found: false, reason: 'timed-out', timedOut: true }],
    ]
    for (const [outcome, data] of cases) {
      using base = tempBase()
      const db = await store(base, ADDRESSES.checking)
      const moved = valueOf(db.tx((q) => applyAddressOutcome(q, 'contact-1', outcome, NOW)))
      assert.deepEqual(moved.address, { status: 'unverified', verifiedUrl: null, checkedAt: NOW.toISOString(), override: null }, outcome.kind)
      assert.deepEqual(addressEvents(db).at(-1), { ...data, contactId: 'contact-1' })
      db.close()
    }
  })

  test('a contact that is not checking, or does not exist, is not written', async () => {
    using base = tempBase()
    const db = await store(base, ADDRESSES.unverifiedToday)
    errorOf(db.tx((q) => applyAddressOutcome(q, 'contact-1', { kind: 'not-found' }, NOW)), 'conflict')
    errorOf(db.tx((q) => applyAddressOutcome(q, 'nobody', { kind: 'not-found' }, NOW)), 'not-found')
    assert.deepEqual(contactOf(db)?.address, ADDRESSES.unverifiedToday)
    db.close()
  })

  test('checkAddress searches the company website and two applications of the contact see the same state', async () => {
    using base = tempBase()
    const db = await store(base, ADDRESSES.checking)
    const { net } = netOf({ [HOME]: page('home', ['/contact']), 'https://acme.example/contact': page(EMAIL) })
    const moved = valueOf(await checkAddress({ db, search: addressSearch(net), now: () => NOW }, 'contact-1'))
    assert.equal(moved.address?.status, 'verified')
    const seen = db.read((q) =>
      ['app-1', 'app-2'].map((id) => repo.getContact(q, repo.getApplication(q, id)?.target.contactId ?? '')?.address),
    )
    assert.deepEqual(seen[0], seen[1])
    assert.deepEqual(seen[0], { status: 'verified', verifiedUrl: 'https://acme.example/contact', checkedAt: NOW.toISOString(), override: null })
    db.close()
  })

  test('checkAddress without a website or a network: unverified with checkedAt, the override kept', async () => {
    using base = tempBase()
    const db = await store(base, { ...ADDRESSES.checking, override: { at: 'x' } }, null)
    const moved = valueOf(await checkAddress({ db, search: addressSearch(netOf({}).net), now: () => NOW }, 'contact-1'))
    assert.deepEqual(moved.address, { status: 'unverified', verifiedUrl: null, checkedAt: NOW.toISOString(), override: { at: 'x' } })
    db.close()
  })

  test('checkAddress of an unknown contact, of one without an address, or once cancelled writes nothing', async () => {
    using base = tempBase()
    const db = await store(base, ADDRESSES.checking)
    const deps = { db, search: async () => ({ kind: 'not-found' }) as const, now: () => NOW }
    errorOf(await checkAddress(deps, 'nobody'), 'not-found')
    valueOf(db.tx((q) => ok(q.run("UPDATE contacts SET address_status = NULL, email = NULL WHERE id = 'contact-1'"))))
    errorOf(await checkAddress(deps, 'contact-1'), 'conflict', 'the contact has no address')
    valueOf(db.tx((q) => ok(q.run("UPDATE contacts SET address_status = 'checking', email = 'ada@acme.example' WHERE id = 'contact-1'"))))
    const controller = new AbortController()
    controller.abort()
    errorOf(await checkAddress(deps, 'contact-1', controller.signal), 'conflict', 'cancelled')
    assert.equal(contactOf(db)?.address?.status, 'checking')
    db.close()
  })

  test('checkAddress of a contact that is not checking does not search; a search that throws is «couldn\'t check»', async () => {
    using base = tempBase()
    const db = await store(base, ADDRESSES.unverifiedNeverChecked)
    let searched = 0
    const counting = { db, search: async (): Promise<AddressOutcome> => {
      searched++
      return { kind: 'not-found' }
    }, now: () => NOW }
    errorOf(await checkAddress(counting, 'contact-1'), 'conflict')
    assert.equal(searched, 0)
    valueOf(db.tx((q) => ok(q.run("UPDATE contacts SET address_status = 'checking' WHERE id = 'contact-1'"))))
    const throwing = { db, search: async () => Promise.reject(new Error('boom')), now: () => NOW }
    assert.equal(valueOf(await checkAddress(throwing, 'contact-1')).address?.status, 'unverified')
    assert.deepEqual(addressEvents(db).at(-1), { found: false, reason: 'unreachable', detail: 'error', contactId: 'contact-1' })
    db.close()
  })
})
