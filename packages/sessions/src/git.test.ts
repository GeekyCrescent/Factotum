import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gitEnv, gitFailureReason, outerBoundMs, runGit } from './git.ts'

const exec = promisify(execFile)

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function repo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'factotum-git-'))
  await exec('git', ['init', '--quiet'], { cwd: dir })
  return dir
}

// ---------------------------------------------------------------------------
// The environment: git may never ask anything (criterion 22)
// ---------------------------------------------------------------------------

test('the environment answers every prompt with a command that fails, and says never to ssh', () => {
  const env = gitEnv({ PATH: '/bin', SSH_ASKPASS: '/usr/lib/ssh/ksshaskpass' }, { sshCommandConfigured: false })
  assert.equal(env['GIT_TERMINAL_PROMPT'], '0')
  // `false`, not the empty string: git reads '' as unset and falls through to SSH_ASKPASS.
  assert.equal(env['GIT_ASKPASS'], 'false')
  assert.equal(env['SSH_ASKPASS'], 'false', 'a desktop askpass is overridden')
  assert.equal(env['SSH_ASKPASS_REQUIRE'], 'never')
  assert.equal(env['GIT_SSH_COMMAND'], 'ssh -o BatchMode=yes')
  assert.equal(env['PATH'], '/bin', 'the rest of the environment travels')
})

test('a GIT_SSH_COMMAND already in the environment is respected', () => {
  const env = gitEnv({ GIT_SSH_COMMAND: 'ssh -i ~/.ssh/deploy' }, { sshCommandConfigured: false })
  assert.equal(env['GIT_SSH_COMMAND'], 'ssh -i ~/.ssh/deploy')
})

test("a repo's core.sshCommand is respected: no GIT_SSH_COMMAND is set over it", () => {
  const env = gitEnv({}, { sshCommandConfigured: true })
  assert.equal('GIT_SSH_COMMAND' in env, false)
})

test('a local command gets no GIT_SSH_COMMAND at all', () => {
  const env = gitEnv({}, { sshCommandConfigured: undefined })
  assert.equal('GIT_SSH_COMMAND' in env, false)
  assert.equal(env['GIT_ASKPASS'], 'false')
})

test('the environment it is given is not changed', () => {
  const base = { PATH: '/bin' }
  gitEnv(base, { sshCommandConfigured: false })
  assert.deepEqual(base, { PATH: '/bin' })
})

// ---------------------------------------------------------------------------
// The reason a failure gives
// ---------------------------------------------------------------------------

test('the reason is the fatal line, not the hint above it', () => {
  const stderr = "hint: Diverging branches can't be fast-forwarded, you need to either:\nhint:\nfatal: Not possible to fast-forward, aborting.\n"
  assert.equal(gitFailureReason(stderr), 'fatal: Not possible to fast-forward, aborting.')
})

test('with no fatal line, the reason is the first line that says something', () => {
  assert.equal(gitFailureReason('\n  \nsomething odd\nmore\n'), 'something odd')
  assert.equal(gitFailureReason(''), undefined)
})

// ---------------------------------------------------------------------------
// runGit against a real repository
// ---------------------------------------------------------------------------

test('runGit answers with stdout', async () => {
  const dir = await repo()
  assert.equal(await runGit(['status', '--porcelain'], 5_000, dir), '')
})

test('a failing command rejects with git’s own reason on the first line', async () => {
  const dir = await repo()
  await assert.rejects(runGit(['rev-list', '--count', 'HEAD..@{u}'], 5_000, dir), (error: Error) => {
    assert.match(error.message.split('\n')[0] ?? '', /^git rev-list failed \(exit 128\): fatal:/)
    return true
  })
})

test('a command that outlives its budget is killed WITH its children, and rejects', async () => {
  // A fake ssh that waits for git to speak first while git waits for it: a hang. Killing git alone
  // leaves this one behind as an orphan, so the whole group goes.
  const dir = await repo()
  const fake = join(dir, 'fake-ssh.sh')
  const pidFile = join(dir, 'ssh.pid')
  await writeFile(fake, `#!/bin/sh\necho $$ > '${pidFile}'\nread answer\nexec sleep 600\n`)
  await chmod(fake, 0o755)
  await exec('git', ['remote', 'add', 'origin', 'ssh://factotum.invalid/repo.git'], { cwd: dir })

  const started = Date.now()
  await assert.rejects(runGit(['fetch', '--quiet'], 500, dir, { ...process.env, GIT_SSH_COMMAND: fake }), /did not finish within 500ms/)
  assert.equal(Date.now() - started < 5_000, true)

  const pid = Number.parseInt(await readFile(pidFile, 'utf8'), 10)
  const deadline = Date.now() + 5_000
  while (isRunning(pid)) {
    if (Date.now() > deadline) throw new Error('the fake ssh outlived the timeout')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
})

test('core.sshCommand in the repo is read and used for a network command', async () => {
  // If BatchMode were forced over it, the fake would never run and fetch would fail some other way.
  const dir = await repo()
  const marker = join(dir, 'ran')
  const fake = join(dir, 'fake-ssh.sh')
  await writeFile(fake, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`)
  await chmod(fake, 0o755)
  await exec('git', ['config', 'core.sshCommand', fake], { cwd: dir })
  await exec('git', ['remote', 'add', 'origin', 'ssh://factotum.invalid/repo.git'], { cwd: dir })

  const { GIT_SSH_COMMAND: _dropped, ...env } = process.env
  await assert.rejects(runGit(['fetch', '--quiet'], 5_000, dir, env))
  await exec('test', ['-f', marker])
})

test("the caller's outer bound leaves room for the probe and the kill, past the process's own budget", () => {
  assert.equal(outerBoundMs(8_000) > 8_000, true)
  assert.equal(outerBoundMs(8_000) < 30_000, true, 'a fetch still fails inside criterion 22’s ceiling')
})
