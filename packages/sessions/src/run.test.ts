import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildArgs } from './run.ts'

const base = { sessionId: 'sid-1', input: 'do the thing', settingsPath: '/state/settings.json' }

function argsFor(invoke: Parameters<typeof buildArgs>[0]['invoke'], resume: boolean): readonly string[] {
  return buildArgs({ ...base, invoke, resume })
}

/** The prompt is the argument right after `-p`. */
function promptOf(args: readonly string[]): string {
  return args[args.indexOf('-p') + 1] ?? ''
}

// ---------------------------------------------------------------------------
// The flags
// ---------------------------------------------------------------------------

test('a first turn identifies itself with --session-id', () => {
  const args = argsFor({ kind: 'none' }, false)
  assert.equal(args[args.indexOf('--session-id') + 1], 'sid-1')
  assert.equal(args.includes('--resume'), false)
})

test('a later turn uses --resume with the SAME id', () => {
  // Measured against the real CLI in block A: it does not fork the id on resume, so
  // the hook payload still says who is calling and criterion 6 survives turn two.
  const args = argsFor({ kind: 'none' }, true)
  assert.equal(args[args.indexOf('--resume') + 1], 'sid-1')
  assert.equal(args.includes('--session-id'), false)
})

test('the output is stream-json, with --verbose, which the CLI requires alongside it', () => {
  const args = argsFor({ kind: 'none' }, false)
  assert.equal(args[args.indexOf('--output-format') + 1], 'stream-json')
  assert.equal(args.includes('--verbose'), true)
})

test('the permission mode is manual and the settings file is passed', () => {
  const args = argsFor({ kind: 'none' }, false)
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'manual')
  assert.equal(args[args.indexOf('--settings') + 1], '/state/settings.json')
})

test('setting sources are the user ones, so the owner’s skills are reachable', () => {
  const args = argsFor({ kind: 'none' }, false)
  assert.equal(args[args.indexOf('--setting-sources') + 1], 'user')
})

test('the argv is EXACTLY this, so nothing can be slipped in unnoticed', () => {
  // Criterion 3 at the one place that could plausibly want a flag that skips
  // permissions. Asserted as an exact list rather than by scanning for the forbidden
  // names, for two reasons: the criterion is a grep over this directory and a grep
  // with exceptions is a grep that gets argued about, and an exact list catches
  // ANYTHING new — including whatever the next such flag ends up being called.
  assert.deepEqual(argsFor({ kind: 'none' }, false), [
    '-p',
    'do the thing',
    '--session-id',
    'sid-1',
    '--output-format',
    'stream-json',
    '--verbose',
    '--setting-sources',
    'user',
    '--permission-mode',
    'manual',
    '--settings',
    '/state/settings.json',
  ])
})

test('and on a resume the only difference is how the session is named', () => {
  const first = argsFor({ kind: 'none' }, false)
  const later = argsFor({ kind: 'none' }, true)
  assert.equal(later.length, first.length)
  assert.deepEqual(
    later.filter((_, i) => i !== later.indexOf('--resume')),
    first.filter((_, i) => i !== first.indexOf('--session-id')),
  )
})

// ---------------------------------------------------------------------------
// The three kinds
// ---------------------------------------------------------------------------

test('kind `none` sends the owner’s text through untouched', () => {
  assert.equal(promptOf(argsFor({ kind: 'none' }, false)), 'do the thing')
})

test('kind `command` prepends the slash command on the FIRST turn', () => {
  assert.equal(promptOf(argsFor({ kind: 'command', name: 'code-review' }, false)), '/code-review do the thing')
})

test('kind `subagent` passes --agent and leaves the text alone', () => {
  const args = argsFor({ kind: 'subagent', name: 'ecc:planner' }, false)
  assert.equal(args[args.indexOf('--agent') + 1], 'ecc:planner')
  assert.equal(promptOf(args), 'do the thing')
})

// ---------------------------------------------------------------------------
// THE BRANCH THIS FILE EXISTS FOR
// ---------------------------------------------------------------------------

test('RESUMING A COMMAND DOES NOT PREPEND IT AGAIN', () => {
  // The predecessor paid for this one in session 019fee20: three conversational
  // turns became three invocations of the same skill, each treating the owner's
  // reply as a brand new brief. On a later turn the text goes through as written.
  assert.equal(promptOf(argsFor({ kind: 'command', name: 'code-review' }, true)), 'do the thing')
})

test('resuming a subagent does not re-pass --agent either', () => {
  // The thread already knows which agent it is. Passing it again is at best noise.
  const args = argsFor({ kind: 'subagent', name: 'ecc:planner' }, true)
  assert.equal(args.includes('--agent'), false)
  assert.equal(promptOf(args), 'do the thing')
})

test('so a follow-up can itself start with a slash command, and the CLI honours it', () => {
  // A consequence of the same branch: with the text going through untouched, the
  // owner can chain `/another-command ...` with the previous turn's context intact.
  const args = buildArgs({ ...base, input: '/summarise it', invoke: { kind: 'command', name: 'code-review' }, resume: true })
  assert.equal(promptOf(args), '/summarise it')
})

test('an empty follow-up to a command does not become a bare slash', () => {
  const args = buildArgs({ ...base, input: '', invoke: { kind: 'command', name: 'x' }, resume: false })
  assert.equal(promptOf(args), '/x')
})
