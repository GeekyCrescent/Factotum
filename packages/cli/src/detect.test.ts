import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detect } from './detect.ts'

const machine = (entries: Record<string, { address: string; internal: boolean }[]>) =>
  (() => entries) as never

test('offers Tailscale first, because a laptop LAN address changes with the cafe', () => {
  const found = detect(
    machine({
      lo0: [{ address: '127.0.0.1', internal: true }],
      en0: [{ address: '192.168.1.42', internal: false }],
      utun4: [{ address: '100.87.1.2', internal: false }],
    }),
  )

  assert.equal(found[0]?.address, '100.87.1.2')
  assert.equal(found[0]?.tailscale, true)
  assert.equal(found[1]?.address, '192.168.1.42')
})

test('skips internal interfaces and public addresses', () => {
  const found = detect(
    machine({
      lo0: [{ address: '127.0.0.1', internal: true }],
      en0: [{ address: '203.0.113.7', internal: false }],
    }),
  )
  assert.deepEqual(found, [])
})

test('finds nothing on a machine with no private network, which init must explain', () => {
  assert.deepEqual(detect(machine({})), [])
})

test('recognises the whole CGNAT range, not just 100.64', () => {
  const found = detect(machine({ utun9: [{ address: '100.127.255.254', internal: false }] }))
  assert.equal(found[0]?.tailscale, true)
})
