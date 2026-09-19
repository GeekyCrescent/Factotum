import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ICONS, navIcon } from './icons.ts'

test('a glyph name a module uses resolves to itself', () => {
  assert.equal(navIcon('bell'), 'bell')
  assert.equal(navIcon('terminal-window'), 'terminal-window')
})

test('the two names the bundled modules declare today resolve to real glyphs', () => {
  assert.equal(navIcon('terminal'), 'terminal-window')
  assert.equal(navIcon('dot'), 'circle')
})

test('an unknown or missing name falls back to a circle, never to nothing', () => {
  assert.equal(navIcon('rocket'), 'circle')
  assert.equal(navIcon(undefined), 'circle')
  assert.equal(navIcon('constructor'), 'circle', 'a name from Object.prototype is not a glyph')
})

test('every glyph is a path that starts with a moveto', () => {
  for (const [name, path] of Object.entries(ICONS)) assert.match(path, /^M/, name)
})
