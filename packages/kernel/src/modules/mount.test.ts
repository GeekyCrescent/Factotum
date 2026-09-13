import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { RouteTable } from '@factotum/core'
import type { BootError } from '../errors.ts'
import { compileRoutes, matchRoute } from './mount.ts'

const ok = () => ({ status: 200 })

function routes(table: RouteTable) {
  return compileRoutes('example', table)
}

test('a literal route matches only itself', () => {
  const compiled = routes({ 'GET /ping': ok })
  assert.ok(matchRoute(compiled, 'GET', '/ping'))
  assert.equal(matchRoute(compiled, 'GET', '/pong'), undefined)
  assert.equal(matchRoute(compiled, 'POST', '/ping'), undefined)
})

test('a parameter is captured and URL-decoded', () => {
  const compiled = routes({ 'GET /places/:id': ok })
  // The ids that travel in a path are real things — an email address, for one.
  const matched = matchRoute(compiled, 'GET', '/places/who%40example.com')
  assert.deepEqual(matched?.params, { id: 'who@example.com' })
})

test('several parameters are captured by name', () => {
  const compiled = routes({ 'PATCH /calendars/:calendarId/events/:eventId': ok })
  const matched = matchRoute(compiled, 'PATCH', '/calendars/work/events/e1')
  assert.deepEqual(matched?.params, { calendarId: 'work', eventId: 'e1' })
})

test('a literal beats a parameter regardless of declaration order', () => {
  // Written the "wrong" way round on purpose: a Record has no contractual order, so
  // leaving this to the author would make /places/new work or not by accident.
  const compiled = routes({
    'GET /places/:id': () => ({ status: 200, body: 'by id' }),
    'GET /places/new': () => ({ status: 200, body: 'the form' }),
  })

  assert.equal(matchRoute(compiled, 'GET', '/places/new')?.params['id'], undefined)
  assert.deepEqual(matchRoute(compiled, 'GET', '/places/abc')?.params, { id: 'abc' })
})

test('a path with a different number of segments does not match', () => {
  const compiled = routes({ 'GET /places/:id': ok })
  assert.equal(matchRoute(compiled, 'GET', '/places'), undefined)
  assert.equal(matchRoute(compiled, 'GET', '/places/a/b'), undefined)
})

test('a nested literal still wins under a parameter prefix', () => {
  const compiled = routes({
    'POST /places/:id/home': () => ({ status: 200 }),
    'DELETE /places/:id': () => ({ status: 204 }),
  })
  assert.ok(matchRoute(compiled, 'POST', '/places/x/home'))
  assert.ok(matchRoute(compiled, 'DELETE', '/places/x'))
})

// ---------------------------------------------------------------------------
// Bad keys are caught at boot, not on the first request that hits one
// ---------------------------------------------------------------------------

test('a malformed key aborts, naming the module and the key', () => {
  assert.throws(
    () => routes({ 'get /ping': ok }),
    (error: BootError) => {
      assert.equal(error.code, 'route-key-invalid')
      assert.match(error.message, /"example"/)
      return true
    },
  )
  assert.throws(() => routes({ 'GET ping': ok }), /route-key-invalid|declares route/)
  assert.throws(() => routes({ ping: ok }), /declares route/)
})

test('two parameters with the same name abort', () => {
  // `params` is flat, so the second would silently shadow the first.
  assert.throws(
    () => routes({ 'PATCH /calendars/:id/events/:id': ok }),
    (error: BootError) => {
      assert.match(error.message, /:id twice/)
      assert.match(error.remedy, /calendarId/)
      return true
    },
  )
})

test('a nameless parameter aborts', () => {
  assert.throws(() => routes({ 'GET /places/:': ok }), /nameless parameter/)
})

test('the root path of a module is a valid key', () => {
  const compiled = routes({ 'GET /': ok })
  assert.ok(matchRoute(compiled, 'GET', '/'))
})
