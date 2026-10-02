/**
 * Launching a service, and killing it (spec 2026-10-02-servicios-en-segundo-plano, D3).
 *
 * ALWAYS A GROUP OF ITS OWN, AND KILLING IS ALWAYS THE GROUP (guardrail 7). The same reason as `runAgent`:
 * a dev server's workers outlive their parent. `killGroup` is `run.ts`'s, not a second copy.
 *
 * A SERVICE IS ITS GROUP. When the leader exits by itself, whatever is left in the group is SIGKILLed:
 * a worker of `next dev` is not left orphaned, and it lets go of the pipe (risk 13).
 *
 * THE SHELL is the owner's login shell, INTERACTIVE (`-l -i -c`): measured under launchd with prod's PATH,
 * `-l -c` has no `pnpm`, because the owner's `~/.zshrc` is what adds it (tasks A1). It arrives as an argv
 * prefix so a test runs `/bin/sh -c` and never reads anybody's dotfiles.
 */

import { spawn } from 'node:child_process'
import type { Timers } from '@factotum/core'
import { killGroup } from '../run.ts'
import { KILL_GRACE_MS } from './shape.ts'

/** How long after `exit` the last `data` may still arrive before `drained` gives up on `close`. */
export const DRAIN_MS = 500

export interface ServiceExit {
  readonly code: number | null
  readonly signal: string | null
}

export interface SpawnedService {
  readonly pid: number
  /** Resolves on the leader's `exit`, NOT `close`: a grandchild holding the pipe does not delay the end. */
  readonly done: Promise<ServiceExit>
  /**
   * Resolves on `close`, or DRAIN_MS after `exit`, whichever comes first. In Node `exit` can arrive before
   * the last `data`; whoever reads the output of a process that just exited waits for this.
   */
  readonly drained: Promise<void>
  /** SIGTERM to the group; if the group still exists after KILL_GRACE_MS, SIGKILL. `graceful: false` = SIGTERM only. */
  readonly kill: (graceful: boolean) => void
}

export interface SpawnInput {
  readonly command: string
  readonly cwd: string
  /** The program and its flags, the command goes last: `[shell, '-l', '-i', '-c']` in the daemon. */
  readonly shell: readonly string[]
  readonly onOutput: (chunk: Buffer) => void
  readonly timers: Timers
}

/**
 * Is anything left in the group? `process.kill(-pgid, 0)`: synchronous, no `ps`. NEVER THROWS.
 *
 * ESRCH → false. EPERM → TRUE: measured on Darwin 25.6, a group of only zombies answers EPERM (and ESRCH once
 * they are reaped) — the same reading as `isAlive` in `locks.ts`. Anything else → true: in doubt it exists,
 * and the cost is one SIGKILL too many, which is swallowed as well.
 */
export function groupExists(pgid: number): boolean {
  try {
    process.kill(-pgid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException | undefined)?.code !== 'ESRCH'
  }
}

/** ANY error, not only ESRCH: the rescue runs inside a timer, where a throw would take the daemon down. */
function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    killGroup(pid, signal)
  } catch {
    // Gone already, or not ours to signal. Either way there is nothing more to do here.
  }
}

/** Throws when nothing could be launched at all (no pid); everything after that arrives through `done`. */
export function spawnService(input: SpawnInput): SpawnedService {
  const [program, ...flags] = input.shell
  if (program === undefined) throw new Error('no shell to run the service with')
  const child = spawn(program, [...flags, input.command], {
    cwd: input.cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  })

  // REGISTERED BEFORE ANYTHING ELSE (risk 10), for the reason `runAgent` gives: an `error` with no listener
  // on a ChildProcess takes the whole daemon down.
  child.on('error', () => undefined)
  const pid = child.pid
  if (pid === undefined) throw new Error(`the service could not be launched with ${program}`)

  child.stdout?.on('data', input.onOutput)
  child.stderr?.on('data', input.onOutput)

  const done = new Promise<ServiceExit>((resolve) => {
    child.on('exit', (code, signal) => {
      // Whatever the leader left behind goes with it (risk 13).
      signalGroup(pid, 'SIGKILL')
      resolve({ code, signal })
    })
  })

  const drained = new Promise<void>((resolve) => {
    child.on('close', () => resolve())
    void done.then(() => input.timers.setTimeout(resolve, DRAIN_MS))
  })

  return {
    pid,
    done,
    drained,
    kill: (graceful) => {
      signalGroup(pid, 'SIGTERM')
      if (!graceful) return
      // Decided by the GROUP, not by whether the leader left: a child ignoring SIGTERM after its leader
      // died is still in there.
      input.timers.setTimeout(() => {
        if (groupExists(pid)) signalGroup(pid, 'SIGKILL')
      }, KILL_GRACE_MS)
    },
  }
}
