/**
 * The subprocess: what the CLI is called with, and how it is killed.
 *
 * `buildArgs` is separated from the launching ON PURPOSE. It is the piece with the
 * subtlety in it, and split out it can be tested exhaustively without spending a
 * single token of quota.
 */

import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { Invoke } from './catalog.ts'
import { clip, MAX_ERROR_CHARS, StreamTranslator } from './parse.ts'
import type { EventInput } from './types.ts'

/** The engine never invokes anything else, and it is never taken from configuration. */
export const CLAUDE_BIN = 'claude'

export interface BuildArgsInput {
  readonly sessionId: string
  readonly invoke: Invoke
  readonly input: string
  readonly settingsPath: string
  /** Second turn and beyond. */
  readonly resume: boolean
}

export function buildArgs(opts: BuildArgsInput): readonly string[] {
  // THE BRANCH THAT IS EASY TO MISS AND EXPENSIVE TO MISS.
  //
  // `none` and `subagent` never prepend anything. `command` prepends ONLY on the first
  // turn: on a resume the owner's text goes through exactly as written.
  //
  // Without this, every reply re-invokes the whole skill and treats the answer as a
  // brand new brief. The predecessor did it for real — three conversational turns
  // became three invocations of `/create-spec` in session 019fee20 — and it is the
  // kind of bug that reads as the model behaving oddly rather than as an argument.
  //
  // It is also what makes chaining work: with the text untouched, the owner can start
  // a follow-up with `/another-command` and the CLI runs it with the thread's context.
  const prompt =
    opts.resume || opts.invoke.kind !== 'command'
      ? opts.input
      : `/${opts.invoke.name} ${opts.input}`.trim()

  const args = [
    '-p',
    prompt,
    opts.resume ? '--resume' : '--session-id',
    opts.sessionId,
    '--output-format',
    'stream-json',
    // The CLI requires it alongside --print and stream-json.
    '--verbose',
    // How the owner's own skills reach the agent without copying anything.
    '--setting-sources',
    'user',
    // The hook decides. There is no terminal here to ask.
    '--permission-mode',
    'manual',
    // ADDITIONAL to ~/.claude, which is how the hook gets in without replacing
    // anything the owner configured.
    '--settings',
    opts.settingsPath,
  ]

  // Same reasoning one step along: the thread already knows which agent it is, so
  // re-declaring it on a resume is at best noise.
  if (!opts.resume && opts.invoke.kind === 'subagent') args.push('--agent', opts.invoke.name)
  return args
}

// ---------------------------------------------------------------------------
// Launching, and killing the GROUP
// ---------------------------------------------------------------------------

export interface AgentExit {
  readonly code: number | null
  readonly signal: string | null
  /** Accumulated and clipped. Enough to say what went wrong, not a second log. */
  readonly stderr: string
}

export interface AgentRun {
  /** The process group leader. `-pid` is the group. */
  readonly pid: number | undefined
  readonly done: Promise<AgentExit>
  readonly kill: () => void
}

export interface RunOptions extends BuildArgsInput {
  readonly cwd: string
  /**
   * Called once per translated event, IN ARRIVAL ORDER.
   *
   * The runner chains these rather than firing them off: two overlapping appends would
   * land in the log in whichever order the disk felt like, and the log is the only
   * record of what order things happened in.
   */
  readonly onEvent: (event: EventInput) => Promise<void>
  readonly bin?: string
}

/**
 * Kills a process GROUP.
 *
 * THE MINUS SIGN IS THE WHOLE THING. The CLI launches its own tools, and those
 * grandchildren outlive their parent while holding the stdout pipe open — so killing
 * the child alone leaves work running, the pipe open, and the session never ending.
 * `detached: true` above is what gives the child a group of its own to be the leader
 * of, and it is also, unavoidably, what lets that group outlive this daemon (risk 18).
 */
export function killGroup(pid: number, signal: NodeJS.Signals = 'SIGTERM'): void {
  process.kill(-pid, signal)
}

export function runAgent(opts: RunOptions): AgentRun {
  const child = spawn(opts.bin ?? CLAUDE_BIN, [...buildArgs(opts)], {
    cwd: opts.cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    // Its own process group, so the group can be killed as one.
    detached: true,
  })

  // REGISTERED BEFORE ANYTHING ELSE, and not out of tidiness. An `error` with no
  // listener on a ChildProcess is an unhandled 'error' event, which in Node takes the
  // whole process down — so cancelling one session would kill the daemon and every
  // other session with it.
  let spawnError: Error | undefined
  child.on('error', (error: Error) => {
    spawnError = error
  })

  let stderr = ''
  child.stderr?.on('data', (chunk: Buffer) => {
    // Bounded as it arrives. A subprocess that fails in a loop would otherwise hold
    // its whole output in memory on the way to being clipped anyway.
    if (stderr.length < MAX_ERROR_CHARS * 2) stderr += chunk.toString('utf8')
  })

  const translator = new StreamTranslator()
  // The chain. Each write waits for the previous one, so the order events are
  // persisted in is the order they arrived in.
  let writes: Promise<void> = Promise.resolve()
  let writeError: Error | undefined

  if (child.stdout !== null) {
    const lines = createInterface({ input: child.stdout })
    lines.on('line', (line: string) => {
      let message: unknown
      try {
        message = JSON.parse(line)
      } catch {
        // A line that is not JSON is not an event. The CLI prints the odd warning on
        // stdout, and one of those must not end a session.
        return
      }
      for (const event of translator.translate(message)) {
        writes = writes.then(async () => {
          try {
            await opts.onEvent(event)
          } catch (error) {
            writeError ??= error as Error
          }
        })
      }
    })
  }

  const done = new Promise<AgentExit>((resolve) => {
    const finish = (code: number | null, signal: string | null): void => {
      // Every event that arrived is on disk before the session is called over.
      void writes.then(() => {
        const failure = spawnError ?? writeError
        resolve({
          code: failure !== undefined ? null : code,
          signal,
          stderr: clip(failure !== undefined ? `${failure.message}\n${stderr}` : stderr, MAX_ERROR_CHARS),
        })
      })
    }

    child.on('close', finish)
    // `spawn` that never started emits `error` and then `close`, so `close` is the one
    // place that resolves — except when there is no process at all to close.
    child.on('error', () => {
      if (child.pid === undefined) finish(null, null)
    })
  })

  return {
    pid: child.pid,
    done,
    kill: () => {
      if (child.pid === undefined) return
      try {
        killGroup(child.pid)
      } catch {
        // Already gone between deciding to kill it and doing so. That is the outcome
        // that was wanted.
      }
    },
  }
}
