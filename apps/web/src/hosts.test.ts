import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fetchHosts, HOSTS_REFRESH_MS, parseHosts, pollDue, sameHosts, type HostView } from './hosts.ts'

const MAC: HostView = { name: 'juans-macbook-pro', self: false, reachable: false, lastSeenAt: null }
const LINUX: HostView = { name: 'omarchy', self: true, reachable: true, lastSeenAt: null }

function answering(response: Response | Error): typeof fetch {
  return async (input) => {
    assert.equal(String(input), '/hosts')
    if (response instanceof Error) throw response
    return response
  }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

test('parseHosts reads what GET /hosts sends: self without lastSeenAt, a peer never seen with null', () => {
  const body = [
    { name: 'omarchy', self: true, reachable: true },
    { name: 'juans-macbook-pro', self: false, reachable: false, lastSeenAt: null },
  ]
  assert.deepEqual(parseHosts(body), [LINUX, MAC])
  const seen = { name: 'mac', self: false, reachable: true, lastSeenAt: '2026-10-08T10:00:00.000Z' }
  assert.deepEqual(parseHosts([seen]), [seen])
})

test('parseHosts drops a malformed entry, keeps no stray key, and refuses what is not a list', () => {
  const body = [{ name: 'omarchy', self: true, reachable: true, extra: 1 }, { name: 3 }, null, { name: 'x', self: 'no', reachable: true }]
  assert.deepEqual(parseHosts(body), [LINUX])
  assert.equal(parseHosts({ hosts: [] }), undefined)
  assert.equal(parseHosts(undefined), undefined)
})

test('fetchHosts: the list, or undefined for anything that is not one — the caller keeps what it had', async () => {
  assert.deepEqual(await fetchHosts(answering(json([{ name: 'omarchy', self: true, reachable: true }]))), [LINUX])
  // A daemon from before /hosts serves the page itself; one starting answers 503; none answers at all.
  assert.equal(await fetchHosts(answering(new Response('<!doctype html>', { headers: { 'content-type': 'text/html' } }))), undefined)
  assert.equal(await fetchHosts(answering(json({ error: { code: 'starting', message: 'starting' } }, 503))), undefined)
  assert.equal(await fetchHosts(answering(new TypeError('Failed to fetch'))), undefined)
})

test('sameHosts: equal content is the same list, so the shell keeps the old array and no effect re-runs', () => {
  assert.equal(sameHosts([LINUX, MAC], [{ ...LINUX }, { ...MAC }]), true)
  assert.equal(sameHosts([LINUX, MAC], [LINUX, { ...MAC, reachable: true }]), false)
  assert.equal(sameHosts([LINUX, MAC], [LINUX, { ...MAC, lastSeenAt: '2026-10-08T10:00:00.000Z' }]), false)
  assert.equal(sameHosts([LINUX], [LINUX, MAC]), false)
})

test('pollDue: at mount always, on becoming visible, and every HOSTS_REFRESH_MS while visible', () => {
  const at = 100_000
  assert.equal(pollDue({ first: true, visible: false, wasVisible: false, now: at, fetchedAt: at }), true)
  assert.equal(pollDue({ first: false, visible: true, wasVisible: false, now: at, fetchedAt: at }), true)
  assert.equal(pollDue({ first: false, visible: true, wasVisible: true, now: at + HOSTS_REFRESH_MS - 1, fetchedAt: at }), false)
  assert.equal(pollDue({ first: false, visible: true, wasVisible: true, now: at + HOSTS_REFRESH_MS, fetchedAt: at }), true)
  assert.equal(pollDue({ first: false, visible: false, wasVisible: true, now: at + 10 * HOSTS_REFRESH_MS, fetchedAt: at }), false)
})
