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

test('NO flag that skips permissions is ever emitted', () => {
  // Criterion 3, at the one place that could plausibly want one.
  const all = [
    argsFor({ kind: 'none' }, false),
    argsFor({ kind: 'command', name: 'x' }, true),
    argsFor({ kind: 'subagent', name: 'y' }, false),
  ].flat()
  assert.equal(
    all.some((arg) => /bypassPermissions|dangerously-skip-permissions|allow-dangerously/i.test(arg)),
    false,
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
