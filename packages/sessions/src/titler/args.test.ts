import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildTitlerArgs } from './args.ts'

const args = buildTitlerArgs({ prompt: 'the prompt', model: 'haiku', effort: 'low' })

test('the prompt, the model and the effort', () => {
  assert.deepEqual(args.slice(0, 2), ['-p', 'the prompt'])
  assert.equal(args[args.indexOf('--model') + 1], 'haiku')
  assert.equal(args[args.indexOf('--effort') + 1], 'low')
})

test('the isolation flags are there (criterion 17)', () => {
  // No tools at all, so there is nothing for the permission gate to decide.
  assert.equal(args[args.indexOf('--tools') + 1], '')
  // No transcript left in the owner's `claude --resume` history.
  assert.ok(args.includes('--no-session-persistence'))
  // None of the owner's hooks, plugins or MCP servers.
  assert.ok(args.includes('--strict-mcp-config'))
  assert.equal(args[args.indexOf('--setting-sources') + 1], '')
  assert.equal(args[args.indexOf('--output-format') + 1], 'text')
})

test('and what a session carries is NOT (criterion 17)', () => {
  for (const flag of ['--resume', '--session-id', '--settings', '--agent', '--permission-mode', '--verbose']) {
    assert.ok(!args.includes(flag), flag)
  }
})
