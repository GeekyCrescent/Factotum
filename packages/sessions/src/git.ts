/**
 * Running git from the daemon, which has nobody to answer a prompt (spec 2026-10-07-dos-hosts, D5).
 *
 * GIT MAY NEVER ASK. A daemon under launchd or systemd has no terminal, and a desktop session may
 * have an askpass that pops a dialog nobody is looking at. So every prompt is answered by a command
 * that fails, and ssh is told never to ask:
 *
 *   - `GIT_TERMINAL_PROMPT=0`;
 *   - `GIT_ASKPASS=false` and `SSH_ASKPASS=false` — the COMMAND `false`, which exits with an error.
 *     NOT the empty string: git reads `GIT_ASKPASS=''` as unset and falls through to `SSH_ASKPASS`,
 *     which a Linux desktop may well have set;
 *   - `SSH_ASKPASS_REQUIRE=never`;
 *   - `GIT_SSH_COMMAND='ssh -o BatchMode=yes'`, ONLY for a network command and ONLY when neither the
 *     environment brings a `GIT_SSH_COMMAND` nor the repo has `core.sshCommand`: the variable wins
 *     over the config, so setting it blindly would throw away a key the owner chose for that repo.
 *
 * AND MAY NEVER HANG. stdin is closed, and the process gets a group of its own that the timeout
 * kills whole: an ssh that waits for input keeps the stdout pipe open after git itself is gone, and
 * with it the promise (the same reason as `killGroup` in `run.ts`).
 */

import { spawn } from 'node:child_process'
import { killGroup } from './run.ts'

/** `git status`, `rev-list` and the like: local, and quick. */
export const GIT_LOCAL_TIMEOUT_MS = 5_000
/** Long enough for a `git fetch` over a slow link, short enough not to be a hang. */
export const FETCH_TIMEOUT_MS = 8_000
/** `merge --ff-only` on a clean tree: local, but it writes the files the commits brought. */
export const GIT_MERGE_TIMEOUT_MS = 15_000
/** `push`, and the handoff's fetch (corte 2). The ceiling of criterion 22. */
export const GIT_NET_TIMEOUT_MS = 30_000

const MAX_OUTPUT_BYTES = 4 * 1024 * 1024
const BATCH_SSH = 'ssh -o BatchMode=yes'

/** The commands that may reach a remote over ssh. Only these read `core.sshCommand` first. */
const NETWORK_COMMANDS = new Set(['fetch', 'pull', 'push', 'ls-remote'])

/** The seam `freshness.ts` and its tests share: a git that answers from a script is one of these. */
export type GitRunner = (args: readonly string[], timeoutMs: number, cwd: string) => Promise<string>

export interface SshChoice {
  /**
   * Whether the repo sets `core.sshCommand`. `undefined` for a LOCAL command, which gets no
   * `GIT_SSH_COMMAND` at all: it never starts ssh.
   */
  readonly sshCommandConfigured: boolean | undefined
}

/** The environment git runs with. A NEW object: `base` is not touched. */
export function gitEnv(base: NodeJS.ProcessEnv, choice: SshChoice): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...base,
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: 'false',
    SSH_ASKPASS: 'false',
    SSH_ASKPASS_REQUIRE: 'never',
  }
  const batch = choice.sshCommandConfigured === false && base['GIT_SSH_COMMAND'] === undefined
  return batch ? { ...env, GIT_SSH_COMMAND: BATCH_SSH } : env
}

/**
 * What a failure says, in one line: the `fatal:` or `error:` line when there is one — git puts its
 * `hint:` lines above it — and otherwise the first line with anything on it.
 */
export function gitFailureReason(stderr: string): string | undefined {
  const lines = stderr.split('\n').map((line) => line.trim()).filter((line) => line !== '')
  return lines.find((line) => /^(fatal|error):/.test(line)) ?? lines[0]
}

interface Outcome {
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
  readonly timedOut: boolean
  readonly spawnError: Error | undefined
}

/**
 * One git process, bounded by `timeoutMs`.
 *
 * The kill timer is the process's own, like the `timeout` of `execFile` it replaces: it lives and
 * dies with the child and is cleared on `close`. The INJECTED timer that bounds the promise is the
 * caller's (`within`, in `freshness.ts`).
 */
function spawnGit(args: readonly string[], timeoutMs: number, cwd: string, env: NodeJS.ProcessEnv): Promise<Outcome> {
  return new Promise((resolve) => {
    const child = spawn('git', [...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let spawnError: Error | undefined
    let settled = false

    const timer = setTimeout(() => {
      timedOut = true
      if (child.pid === undefined) return
      try {
        killGroup(child.pid, 'SIGKILL')
      } catch {
        // Already gone between the timer firing and the kill: the outcome that was wanted.
      }
    }, timeoutMs)
    timer.unref()

    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length < MAX_OUTPUT_BYTES) stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_OUTPUT_BYTES) stderr += chunk.toString('utf8')
    })

    const settle = (code: number | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code, stdout, stderr, timedOut, spawnError })
    }
    // A missing binary emits `error` and may never emit `close` (see the titler).
    child.on('error', (error: Error) => {
      spawnError = error
      if (child.pid === undefined) settle(null)
    })
    child.on('close', (code: number | null) => settle(code))
  })
}

/** Does this repo set `core.sshCommand`? Unset is exit 1 with no output, which is the common case. */
async function sshCommandConfigured(cwd: string, base: NodeJS.ProcessEnv): Promise<boolean> {
  const env = gitEnv(base, { sshCommandConfigured: undefined })
  const outcome = await spawnGit(['config', '--get', 'core.sshCommand'], GIT_LOCAL_TIMEOUT_MS, cwd, env)
  return outcome.code === 0 && outcome.stdout.trim() !== ''
}

/**
 * Runs git and answers its stdout. REJECTS on a non-zero exit, a spawn error or the timeout, with
 * what happened on the FIRST line — `freshness.ts` keeps only that one.
 *
 * `base` is a seam for the tests, which need a `GIT_SSH_COMMAND` without touching `process.env`.
 */
export async function runGit(
  args: readonly string[],
  timeoutMs: number,
  cwd: string,
  base: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const command = args[0] ?? ''
  const configured = NETWORK_COMMANDS.has(command) ? await sshCommandConfigured(cwd, base) : undefined
  const outcome = await spawnGit(args, timeoutMs, cwd, gitEnv(base, { sshCommandConfigured: configured }))

  if (outcome.timedOut) throw new Error(`git ${command} did not finish within ${timeoutMs}ms`)
  if (outcome.spawnError !== undefined) throw outcome.spawnError
  if (outcome.code !== 0) {
    const reason = gitFailureReason(outcome.stderr) ?? 'no message'
    throw new Error(`git ${command} failed (exit ${outcome.code ?? 'signal'}): ${reason}`)
  }
  return outcome.stdout
}
