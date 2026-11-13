import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildClaudeArgs } from './args.ts'

test('the arguments are tasks’ own: no tools, no session, no settings, the schema, and nothing after -p', () => {
  assert.deepEqual(buildClaudeArgs({ model: 'sonnet', effort: 'low', schema: '{"type":"object"}' }), [
    '-p',
    '--model',
    'sonnet',
    '--effort',
    'low',
    '--tools',
    '',
    '--no-session-persistence',
    '--strict-mcp-config',
    '--setting-sources',
    '',
    '--output-format',
    'json',
    '--json-schema',
    '{"type":"object"}',
  ])
})

test('without effort, no --effort; without systemFile, no --append-system-prompt-file', () => {
  const args = buildClaudeArgs({ model: 'sonnet', effort: undefined, schema: '{}' })
  assert.equal(args.includes('--effort'), false)
  assert.equal(args.includes('--append-system-prompt-file'), false)
})

test('A4: the fixed prefix goes as --append-system-prompt-file <path>, never its text in argv', () => {
  const args = buildClaudeArgs({ model: 'sonnet', effort: undefined, schema: '{}', systemFile: '/state/prompts/master-abc.txt' })
  const at = args.indexOf('--append-system-prompt-file')
  assert.notEqual(at, -1)
  assert.equal(args[at + 1], '/state/prompts/master-abc.txt')
  // The prompt still goes by stdin: -p is first and takes nothing after it.
  assert.equal(args[0], '-p')
  assert.equal(args[1], '--model')
})
