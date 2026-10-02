import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  BACKGROUND_REDIRECT,
  DEFAULT_LINES,
  DEFAULT_MAX_MINUTES,
  MAX_COMMAND_CHARS,
  MAX_DESCRIPTION_CHARS,
  MAX_LINES,
  MAX_MAX_MINUTES,
  QUALIFIED_START,
  SERVICE_OUTCOMES,
  SERVICE_OUTPUT_SUMMARY,
  parseId,
  parseRead,
  parseStart,
  type StartRequest,
} from './shape.ts'

const SITE = '/work/repo'

function started(raw: unknown): StartRequest {
  const result = parseStart(raw, SITE)
  if (result.kind !== 'ok') throw new Error(`expected a request, got: ${result.reason}`)
  return result.request
}

function refused(raw: unknown): string {
  const result = parseStart(raw, SITE)
  if (result.kind !== 'invalid') throw new Error('expected a refusal, got a request')
  return result.reason
}

// --- parseStart (criterion 7) ------------------------------------------------

test('a command alone runs in the site, for the default 8 hours', () => {
  assert.deepEqual(started({ command: 'python3 -m http.server 8765' }), {
    command: 'python3 -m http.server 8765',
    description: undefined,
    cwd: SITE,
    maxMinutes: DEFAULT_MAX_MINUTES,
  })
  assert.equal(DEFAULT_MAX_MINUTES, 480)
})

test('no command, an empty one or one of only spaces is refused with what to fix', () => {
  for (const raw of [{}, { command: '' }, { command: '   ' }, { command: 42 }, null, 'pnpm dev', []]) {
    assert.match(refused(raw), /command/)
  }
})

test('a command over the limit is REFUSED, never clipped: clipping a command changes what it runs', () => {
  assert.match(refused({ command: 'x'.repeat(MAX_COMMAND_CHARS + 1) }), new RegExp(String(MAX_COMMAND_CHARS)))
  assert.equal(started({ command: 'x'.repeat(MAX_COMMAND_CHARS) }).command.length, MAX_COMMAND_CHARS)
})

test('max_minutes 0, 1441, a fraction or a string is refused; 1 and 1440 are accepted', () => {
  for (const max of [0, -5, MAX_MAX_MINUTES + 1, 1.5, '60', Number.NaN]) {
    assert.match(refused({ command: 'x', max_minutes: max }), /max_minutes/)
  }
  assert.equal(started({ command: 'x', max_minutes: 1 }).maxMinutes, 1)
  assert.equal(started({ command: 'x', max_minutes: MAX_MAX_MINUTES }).maxMinutes, 1_440)
})

test('a long description is CLIPPED, not refused: it is presentation', () => {
  const request = started({ command: 'x', description: `  ${'d'.repeat(MAX_DESCRIPTION_CHARS + 50)}  ` })
  assert.equal(request.description?.length, MAX_DESCRIPTION_CHARS)
  assert.equal(started({ command: 'x', description: '   ' }).description, undefined)
  assert.equal(started({ command: 'x', description: 7 }).description, undefined)
})

test('a relative cwd is resolved against the site; an absolute one is kept, inside the site or not', () => {
  assert.equal(started({ command: 'x', cwd: 'apps/web' }).cwd, '/work/repo/apps/web')
  assert.equal(started({ command: 'x', cwd: '../other' }).cwd, '/work/other')
  assert.equal(started({ command: 'x', cwd: '/tmp/elsewhere/' }).cwd, '/tmp/elsewhere')
  assert.equal(started({ command: 'x', cwd: '' }).cwd, SITE)
  assert.match(refused({ command: 'x', cwd: 3 }), /cwd/)
})

// --- parseRead / parseId (criterion 9) ---------------------------------------

test('parseRead: 50 lines by default, a request over 200 is clipped to 200', () => {
  assert.deepEqual(parseRead({ id: 's1' }), { kind: 'ok', id: 's1', lines: DEFAULT_LINES })
  assert.deepEqual(parseRead({ id: 's1', lines: 10 }), { kind: 'ok', id: 's1', lines: 10 })
  assert.deepEqual(parseRead({ id: 's1', lines: 5_000 }), { kind: 'ok', id: 's1', lines: MAX_LINES })
})

test('parseRead: no id, or lines that is not a positive integer, is refused', () => {
  for (const raw of [{}, { id: '' }, { id: 's1', lines: 0 }, { id: 's1', lines: 2.5 }, { id: 's1', lines: '10' }, null]) {
    assert.equal(parseRead(raw).kind, 'invalid')
  }
})

test('parseId: an id is a non-empty string, trimmed', () => {
  assert.deepEqual(parseId({ id: ' s3 ' }), { kind: 'ok', id: 's3' })
  for (const raw of [{}, { id: '' }, { id: 4 }, undefined]) assert.equal(parseId(raw).kind, 'invalid')
  assert.equal(parseId({ id: 'x'.repeat(65) }).kind, 'invalid')
})

// --- the constants the rest of the spec leans on ------------------------------

test('the six outcomes, the fixed summary and the redirect that names the tool', () => {
  assert.deepEqual([...SERVICE_OUTCOMES], ['exited', 'failed', 'stopped', 'timeout', 'cancelled', 'shutdown'])
  assert.equal(SERVICE_OUTPUT_SUMMARY, 'output read')
  assert.equal(QUALIFIED_START, 'mcp__factotum__start_service')
  assert.ok(BACKGROUND_REDIRECT.includes(QUALIFIED_START))
  // The sentence A4 added for a subagent without MCP tools (tasks §M).
  assert.match(BACKGROUND_REDIRECT, /ask whoever launched you/)
})
