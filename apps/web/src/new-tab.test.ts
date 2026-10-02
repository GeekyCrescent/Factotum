import { test } from 'node:test'
import assert from 'node:assert/strict'
import { newTabIntent, wantsNewTab } from './new-tab.ts'

const click = (over: Partial<{ metaKey: boolean; ctrlKey: boolean; button: number }> = {}) => ({
  metaKey: false,
  ctrlKey: false,
  button: 0,
  ...over,
})

test('⌘-click and Ctrl-click ask for a new tab; a plain click does not', () => {
  assert.equal(wantsNewTab(click({ metaKey: true })), true)
  assert.equal(wantsNewTab(click({ ctrlKey: true })), true)
  assert.equal(wantsNewTab(click()), false)
})

test('only the main button counts: a modified right or middle click is not a new-tab click', () => {
  assert.equal(wantsNewTab(click({ metaKey: true, button: 1 })), false)
  assert.equal(wantsNewTab(click({ metaKey: true, button: 2 })), false)
})

test('the intent is taken once: the click that set it opens one tab, not two', () => {
  const intent = newTabIntent(() => undefined)
  intent.record(click({ metaKey: true }))
  assert.equal(intent.take(), true)
  assert.equal(intent.take(), false)
})

test('the intent does not outlive its click: a navigation later, from an effect, stays in this tab', () => {
  let expire: () => void = () => undefined
  const intent = newTabIntent((fn) => {
    expire = fn
  })
  intent.record(click({ metaKey: true }))
  expire()
  assert.equal(intent.take(), false)
})

test('a plain click clears a modified one before it', () => {
  const intent = newTabIntent(() => undefined)
  intent.record(click({ metaKey: true }))
  intent.record(click())
  assert.equal(intent.take(), false)
})
