import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createMockupsLink } from './link.ts'

const CALL = { sessionId: 's', siteId: 'p', toolUseId: undefined, name: 'submit_stage', raw: {} }

test('empty: no tools, and a call is answered with an error, never thrown', async () => {
  const link = createMockupsLink()
  assert.deepEqual(link.family.tools(), [])
  const result = await link.family.call(CALL)
  assert.equal(result.isError, true)
})

test('filled, it answers with the implementation; cleared, it is empty again', async () => {
  const link = createMockupsLink()
  link.fill({ tools: () => [{ name: 'submit_stage', description: 'd', inputSchema: {} }], call: async () => ({ content: [{ type: 'text', text: 'ok' }] }) })
  assert.equal(link.family.tools().length, 1)
  assert.deepEqual(await link.family.call(CALL), { content: [{ type: 'text', text: 'ok' }] })
  link.clear()
  assert.deepEqual(link.family.tools(), [])
})
