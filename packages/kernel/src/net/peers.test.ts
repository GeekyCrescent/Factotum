import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Logger } from '@factotum/core'
import { createPeerTable, machineName } from './peers.ts'

const MAC = 'https://juans-macbook-pro.tailbd0167.ts.net:8443'

const silent: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined }

const table = (origins: readonly string[] = [MAC]) =>
  createPeerTable({ peers: origins.map((origin) => ({ origin })), log: silent })

// ---------------------------------------------------------------------------
// machineName: one place, because a host's name is its key everywhere
// ---------------------------------------------------------------------------

test('machineName is the first label of the hostname, without port or tailnet', () => {
  assert.equal(machineName(MAC), 'juans-macbook-pro')
  assert.equal(machineName('https://omarchy.tailbd0167.ts.net'), 'omarchy')
  assert.equal(machineName('http://localhost:7777'), 'localhost')
  // Why the tests pair `localhost` with `127.0.0.1` and never two of the same (design D2).
  assert.equal(machineName('http://127.0.0.1:7777'), '127')
})

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

test('a peer starts unreachable and never seen: nothing has asked it yet', () => {
  const peers = table()
  assert.deepEqual(peers.list(), [
    { name: 'juans-macbook-pro', origin: MAC, reachable: false, lastSeenAt: undefined, version: undefined, devices: 0 },
  ])
})

test('get finds a peer by its name, and nothing else', () => {
  const peers = table()
  assert.equal(peers.get('juans-macbook-pro')?.origin, MAC)
  assert.equal(peers.get('omarchy'), undefined)
  assert.equal(peers.get(MAC), undefined)
})

test('no peers is an empty table', () => {
  assert.deepEqual(table([]).list(), [])
})
