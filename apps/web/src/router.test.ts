import { test } from 'node:test'
import assert from 'node:assert/strict'
import { historyStep, locationOf, navigateTarget, onLoad, overlayOf, pathOf, screenOf, type HistoryState } from './router.ts'

test('screenOf and pathOf are inverse on every valid screen', () => {
  for (const path of ['/', '/device', '/m/sessions', '/m/sessions/new', '/m/sessions/019a-bc', '/m/x/a/b']) {
    assert.equal(pathOf(screenOf(path)), path, path)
  }
})

test('a module screen carries its id and what follows it', () => {
  assert.deepEqual(screenOf('/m/sessions/new'), { kind: 'module', id: 'sessions', rest: 'new' })
  assert.deepEqual(screenOf('/m/x/'), { kind: 'module', id: 'x', rest: '' })
  assert.deepEqual(screenOf('/m/x'), { kind: 'module', id: 'x', rest: '' })
})

test('an id is the whole segment, never a prefix of another (what route.test.ts guarded before)', () => {
  assert.deepEqual(screenOf('/m/sessions-old/x'), { kind: 'module', id: 'sessions-old', rest: 'x' })
})

test('the kernel paths are never a client screen', () => {
  for (const path of ['/modules', '/modules/x', '/push', '/push/public-key', '/health']) {
    assert.equal(screenOf(path).kind, 'unknown', path)
  }
  assert.equal(screenOf('/pushup').kind, 'unknown', 'not reserved, just unknown')
})

test('onLoad takes the query out and hands it over; no query and no overlay, nothing to do', () => {
  assert.deepEqual(onLoad({ pathname: '/m/sessions/a', search: '?ask=T' }, null), {
    replaceWith: { path: '/m/sessions/a', state: null },
    search: '?ask=T',
  })
  assert.deepEqual(onLoad({ pathname: '/m/sessions/a', search: '' }, null), { replaceWith: undefined, search: '' })
})

test('onLoad never restores an overlay: a reload with the drawer open opens it closed', () => {
  assert.deepEqual(onLoad({ pathname: '/m/sessions/a', search: '' }, { overlay: 'drawer' }), {
    replaceWith: { path: '/m/sessions/a', state: null },
    search: '',
  })
})

test('historyStep pushes normally, and REPLACES the overlay entry when one is on top', () => {
  assert.deepEqual(historyStep(null, { path: '/m/s/b' }), { op: 'push', path: '/m/s/b', state: null })
  assert.deepEqual(historyStep({ overlay: 'drawer' }, { path: '/m/s/b' }), { op: 'replace', path: '/m/s/b', state: null })
  assert.deepEqual(historyStep(null, { path: '/m/s/b', replace: true }), { op: 'replace', path: '/m/s/b', state: null })
})

test('locationOf splits a worker path into pathname and query', () => {
  assert.deepEqual(locationOf('/m/sessions/b?ask=T'), { pathname: '/m/sessions/b', search: '?ask=T' })
  assert.deepEqual(locationOf('/m/sessions/b'), { pathname: '/m/sessions/b', search: '' })
})

/** A history that records every entry, so a test can look at all of them. */
function fakeHistory(start: string) {
  const entries: { url: string; state: HistoryState | null }[] = [{ url: start, state: null }]
  let index = 0
  return {
    entries,
    get top() {
      return entries[index]!
    },
    push(url: string, state: HistoryState | null) {
      entries.splice(index + 1)
      entries.push({ url, state })
      index = entries.length - 1
    },
    replace(url: string, state: HistoryState | null) {
      entries[index] = { url, state }
    },
    back() {
      index = Math.max(0, index - 1)
      return entries[index]!
    },
  }
}

test('THE TOKEN NEVER STAYS IN THE HISTORY: load with ?ask=, open the sheet, go back (spec §0.17, criterion 11)', () => {
  const token = 'T'.repeat(43)
  const history = fakeHistory(`/m/sessions/B?ask=${token}`)

  // The shell, before the first render.
  const [pathname, query] = history.top.url.split('?') as [string, string]
  const loaded = onLoad({ pathname, search: `?${query}` }, history.top.state)
  if (loaded.replaceWith !== undefined) history.replace(loaded.replaceWith.path, loaded.replaceWith.state)
  assert.equal(loaded.search, `?ask=${token}`, 'the screen still gets it, once')

  // A child opens the approval sheet: an overlay entry on the SAME url.
  history.push(history.top.url, { overlay: 'ask' })
  // Back closes it.
  history.back()
  // Opening the drawer and choosing another session replaces the drawer's entry.
  history.push(history.top.url, { overlay: 'drawer' })
  const step = historyStep(history.top.state, { path: '/m/sessions/C' })
  if (step.op === 'replace') history.replace(step.path, step.state)
  else history.push(step.path, step.state)

  for (const entry of history.entries) assert.equal(entry.url.includes(token), false, `an entry keeps the token: ${entry.url}`)
  assert.deepEqual(
    history.entries.map((e) => e.url),
    ['/m/sessions/B', '/m/sessions/C'],
    'Back from C lands on B, with no drawer entry in between',
  )
})

test('overlayOf reads only a string overlay out of whatever history.state holds', () => {
  assert.equal(overlayOf({ overlay: 'drawer' }), 'drawer')
  assert.equal(overlayOf({ overlay: 3 }), undefined)
  assert.equal(overlayOf('drawer'), undefined)
  assert.equal(overlayOf(null), undefined)
})

test('a worker message navigates only to a path on this origin', () => {
  assert.equal(navigateTarget({ type: 'navigate', path: '/m/sessions/b?ask=T' }), '/m/sessions/b?ask=T')
  assert.equal(navigateTarget({ type: 'navigate', path: '//evil.example/x' }), undefined)
  assert.equal(navigateTarget({ type: 'navigate', path: 'https://evil.example/x' }), undefined)
  assert.equal(navigateTarget({ type: 'pending', key: 'a:b' }), undefined)
  assert.equal(navigateTarget(null), undefined)
})
