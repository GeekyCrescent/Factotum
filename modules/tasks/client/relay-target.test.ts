import { test } from 'node:test'
import assert from 'node:assert/strict'
import { relayTarget } from './where.ts'

const hosts = [
  { name: 'mac', self: true, reachable: true },
  { name: 'omarchy', self: false, reachable: true },
]

test('crit. 29b: the board on the other host goes through the proxy; on the serving host, without it', () => {
  assert.deepEqual(relayTarget('omarchy', hosts), { kind: 'peer' })
  assert.deepEqual(relayTarget('mac', hosts), { kind: 'self' })
})

test('crit. 29b: a host down, or not one of this app’s, is unreachable; without hosts yet, wait', () => {
  assert.deepEqual(relayTarget('omarchy', [hosts[0]!, { ...hosts[1]!, reachable: false }]), { kind: 'unreachable' })
  assert.deepEqual(relayTarget('ghost', hosts), { kind: 'unreachable' })
  assert.equal(relayTarget('omarchy', []), undefined)
})
