import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toClientHost, toStoredHost, whereOf, type Where } from './where.ts'

// The board lives on omarchy. Two apps show it: omarchy's own, and the Mac's through the proxy.
const OMARCHY_APP: Where = { boardHost: undefined, selfName: 'omarchy' }
const MAC_APP: Where = { boardHost: 'omarchy', selfName: 'mac' }

test('crit. 30b: a project on omarchy (stored null) is reached on omarchy from both apps', () => {
  assert.equal(toClientHost(null, OMARCHY_APP), undefined) // omarchy's app: its own host
  assert.equal(toClientHost(null, MAC_APP), 'omarchy') // the Mac's app: across the proxy
})

test('crit. 30b: a project on the Mac (stored "mac") is reached on the Mac from both apps', () => {
  assert.equal(toClientHost('mac', OMARCHY_APP), 'mac') // omarchy's app: across the proxy
  assert.equal(toClientHost('mac', MAC_APP), undefined) // the Mac's app: its own host
})

test('crit. 30b: what each app chose is stored the same, whichever app wrote it', () => {
  // Launching on omarchy: from omarchy's app that is «here», from the Mac's it is «omarchy».
  assert.equal(toStoredHost(undefined, OMARCHY_APP), null)
  assert.equal(toStoredHost('omarchy', MAC_APP), null)
  // Launching on the Mac.
  assert.equal(toStoredHost('mac', OMARCHY_APP), 'mac')
  assert.equal(toStoredHost(undefined, MAC_APP), 'mac')
})

test('a round trip lands on the same host in both apps', () => {
  for (const stored of [null, 'mac'] as const) {
    for (const where of [OMARCHY_APP, MAC_APP]) assert.equal(toStoredHost(toClientHost(stored, where), where), stored)
  }
})

test('whereOf: the board host from the screen, the app’s own name from hosts; nothing until hosts answers', () => {
  const hosts = [
    { name: 'mac', self: true },
    { name: 'omarchy', self: false },
  ]
  assert.deepEqual(whereOf('omarchy', hosts), MAC_APP)
  assert.deepEqual(whereOf(undefined, [{ name: 'omarchy', self: true }]), OMARCHY_APP)
  assert.equal(whereOf(undefined, []), undefined)
  // The board's screen reached as /h/<self>/… is the serving host: never through /peers/<self>/.
  assert.deepEqual(whereOf('mac', hosts), { boardHost: undefined, selfName: 'mac' })
})
