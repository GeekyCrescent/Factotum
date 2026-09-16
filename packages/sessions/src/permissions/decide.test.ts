import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decide, isWritingTool, resolveTarget } from './decide.ts'
import type { Site } from '../sites.ts'

const SITE: Site = { id: 'work', path: '/work/site', realPath: '/work/site', isRepo: true }
const CWD = '/work/site'

const ask = (toolName: string, toolInput: unknown, cwd = CWD) => decide({ toolName, toolInput, cwd, site: SITE })

// ---------------------------------------------------------------------------
// Shared paths: the same directory reachable from EVERY site
//
// The case they exist for: one agent per project, running at the same time, all of
// them writing notes into one vault. A session has exactly one site, so without this
// the only way to express it is one huge site — which is one lock, so one agent.
// ---------------------------------------------------------------------------

const VAULT: Site = { id: 'shared', path: '/home/vault', realPath: '/home/vault', isRepo: false }
const askShared = (toolInput: unknown) =>
  decide({ toolName: 'Write', toolInput, cwd: CWD, site: SITE, shared: [VAULT] })

test('a shared path is writable from a session whose site is somewhere else', () => {
  assert.deepEqual(askShared({ file_path: '/home/vault/notas/hoy.md' }), {
    decision: 'allow',
    reason: 'writes into a shared path',
  })
})

test('the site still works when shared paths are declared', () => {
  assert.equal(askShared({ file_path: '/work/site/a.ts' }).decision, 'allow')
})

test('outside BOTH is still denied, and the reason names what was allowed', () => {
  // The old message named only the site. With shared paths declared it would send
  // someone to check a boundary that was not the whole boundary.
  const result = askShared({ file_path: '/etc/passwd' })
  assert.equal(result.decision, 'deny')
  assert.match(result.reason, /writes outside work/)
  assert.match(result.reason, /\/home\/vault/)
  assert.match(result.reason, /\/etc\/passwd/)
})

test('a sibling of a shared path is NOT inside it', () => {
  // The separator, again: `/home/vaultX` is not `/home/vault`.
  assert.equal(askShared({ file_path: '/home/vaultX/a.md' }).decision, 'deny')
})

test('with no shared paths the message is exactly what it was', () => {
  // The live-verified string. Changing it for everyone to serve the new feature would
  // be making the common case pay for the rare one.
  const result = ask('Write', { file_path: '/etc/passwd' })
  assert.equal(result.reason, 'writes outside work: /etc/passwd')
})

test('a shared path is matched by its REAL spelling too, like a site', () => {
  // macOS: /tmp is a symlink to /private/tmp, and the CLI reports resolved paths.
  const tmp: Site = { id: 'shared', path: '/tmp/vault', realPath: '/private/tmp/vault', isRepo: false }
  const result = decide({
    toolName: 'Write',
    toolInput: { file_path: '/private/tmp/vault/a.md' },
    cwd: CWD,
    site: SITE,
    shared: [tmp],
  })
  assert.equal(result.decision, 'allow')
})

// ---------------------------------------------------------------------------
// The boundary
// ---------------------------------------------------------------------------

test('writing INSIDE the site is allowed', () => {
  assert.deepEqual(ask('Write', { file_path: '/work/site/notes/a.md' }), {
    decision: 'allow',
    reason: 'writes where it belongs',
  })
})

test('writing OUTSIDE the site is denied, and the reason names the path', () => {
  // The path is in the message on purpose: without it, the owner has to guess what
  // the agent was reaching for, and a warning nobody can act on gets switched off.
  const result = ask('Write', { file_path: '/etc/passwd' })
  assert.equal(result.decision, 'deny')
  assert.match(result.reason, /writes outside work: \/etc\/passwd/)
})

test('a sibling directory whose name starts the same is outside', () => {
  assert.equal(ask('Write', { file_path: '/work/site-backup/a' }).decision, 'deny')
})

test('the site root itself is inside', () => {
  assert.equal(ask('Write', { file_path: '/work/site' }).decision, 'allow')
})

test('a RELATIVE path is resolved against the session cwd', () => {
  assert.equal(ask('Write', { file_path: 'notes/a.md' }).decision, 'allow')
})

test('a relative path that climbs out is denied', () => {
  assert.equal(ask('Write', { file_path: '../elsewhere/a.md' }).decision, 'deny')
})

test('a cwd deeper inside the site still resolves correctly', () => {
  assert.equal(ask('Write', { file_path: 'b.md' }, '/work/site/sub').decision, 'allow')
})

// ---------------------------------------------------------------------------
// Criterion 5 — reading never asks
// ---------------------------------------------------------------------------

test('READING a file outside the site is allowed', () => {
  // What needs approval is propagating outside. Reading does not propagate, and a
  // prompt on every read would make the whole thing unusable.
  const result = ask('Read', { file_path: '/etc/passwd' })
  assert.deepEqual(result, { decision: 'allow', reason: 'reading does not propagate' })
})

test('Glob, Grep and the rest are allowed wherever they point', () => {
  for (const tool of ['Read', 'Glob', 'Grep', 'WebFetch', 'Task']) {
    assert.equal(ask(tool, { path: '/anywhere/at/all' }).decision, 'allow')
  }
})

// ---------------------------------------------------------------------------
// The three path keys
// ---------------------------------------------------------------------------

test('all three path keys are checked', () => {
  assert.equal(ask('Write', { file_path: '/outside/a' }).decision, 'deny')
  assert.equal(ask('Edit', { path: '/outside/a' }).decision, 'deny')
  assert.equal(ask('NotebookEdit', { notebook_path: '/outside/a.ipynb' }).decision, 'deny')
})

test('the four writing tools are the four that get checked', () => {
  for (const tool of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']) {
    assert.equal(isWritingTool(tool), true)
    assert.equal(ask(tool, { file_path: '/outside/a' }).decision, 'deny')
  }
})

test('Bash is NOT checked, and that is the declared hole rather than an oversight', () => {
  // `echo x > /outside` goes through. Checking a path inside a shell command means
  // parsing shell, and parsing shell badly is worse than not parsing it. Risk 3, open
  // question 6, written in the README rather than hidden.
  assert.equal(isWritingTool('Bash'), false)
  assert.equal(ask('Bash', { command: 'echo x > /etc/passwd' }).decision, 'allow')
})

test('a writing tool with no destination path is allowed', () => {
  assert.deepEqual(ask('Write', { content: 'no path here' }), {
    decision: 'allow',
    reason: 'no destination path',
  })
  assert.equal(ask('Write', undefined).decision, 'allow')
  assert.equal(ask('Write', 'a string').decision, 'allow')
  assert.equal(ask('Write', { file_path: '' }).decision, 'allow')
})

// ---------------------------------------------------------------------------
// `ask` is never produced
// ---------------------------------------------------------------------------

test('no input produces `ask`, which is ADR-0006 in one assertion', () => {
  const inputs: unknown[] = [
    { file_path: '/work/site/a' },
    { file_path: '/etc/passwd' },
    { path: '../out' },
    {},
    null,
    42,
  ]
  for (const tool of ['Write', 'Edit', 'Read', 'Bash', 'NotebookEdit']) {
    for (const input of inputs) {
      assert.notEqual(ask(tool, input).decision, 'ask')
    }
  }
})

// ---------------------------------------------------------------------------
// It is pure
// ---------------------------------------------------------------------------

test('the same question twice gives the same answer', () => {
  const once = ask('Write', { file_path: '/etc/passwd' })
  const twice = ask('Write', { file_path: '/etc/passwd' })
  assert.deepEqual(once, twice)
})

test('resolveTarget picks the first key present, and undefined when none is', () => {
  assert.equal(resolveTarget({ file_path: '/a/b' }, CWD), '/a/b')
  assert.equal(resolveTarget({ notebook_path: 'n.ipynb' }, CWD), '/work/site/n.ipynb')
  assert.equal(resolveTarget({ nothing: 'here' }, CWD), undefined)
  assert.equal(resolveTarget(null, CWD), undefined)
})

test('a site reached by a symlinked spelling is inside under both', () => {
  // The macOS case: the owner declares /tmp/x, the CLI reports /private/tmp/x.
  const site: Site = { id: 'work', path: '/tmp/x', realPath: '/private/tmp/x', isRepo: false }
  const both = (target: string) =>
    decide({ toolName: 'Write', toolInput: { file_path: target }, cwd: '/tmp/x', site }).decision
  assert.equal(both('/tmp/x/a.txt'), 'allow')
  assert.equal(both('/private/tmp/x/a.txt'), 'allow')
  assert.equal(both('/private/tmp/y/a.txt'), 'deny')
})
