import { test } from 'node:test'
import assert from 'node:assert/strict'
import { routeOf } from './settings-route.ts'

test('`rest` is the screen and, after «#», the place on it', () => {
  assert.deepEqual(routeOf(''), { screen: 'tracker', anchor: null })
  assert.deepEqual(routeOf('review'), { screen: 'review', anchor: null })
  assert.deepEqual(routeOf('settings'), { screen: 'settings', anchor: null })
  assert.deepEqual(routeOf('settings#portfolio'), { screen: 'settings', anchor: 'portfolio' })
  assert.deepEqual(routeOf('a/123'), { screen: 'other', anchor: null })
})

test('an anchor that is not a plain field name is dropped, never put in a selector', () => {
  assert.deepEqual(routeOf('settings#x"]'), { screen: 'settings', anchor: null })
  assert.deepEqual(routeOf('settings#'), { screen: 'settings', anchor: null })
})
