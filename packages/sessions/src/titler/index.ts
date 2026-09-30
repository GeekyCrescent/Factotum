/**
 * The titler: names a new conversation from its first message, once, in the background (spec
 * 2026-09-30, D4, D5).
 *
 * THE SIGNATURE IS THE GUARDRAIL. It is handed ONE function that writes — not the store, not the
 * locks, not the site. So it cannot take a lock, append an event or touch a project's folder,
 * whoever edits it next and whatever they forget.
 *
 * NOTHING HERE THROWS, OUTWARD OR INTO A TIMER. `start` runs right after `launch` has handed a live
 * session over, so an exception would turn a started conversation into a failed request. And the
 * kernel calls a timer's callback bare (`registry.ts:95-96`), so one thrown in there is an uncaught
 * exception that takes the daemon down. Every path ends in a log line instead.
 *
 * AND NOTHING RETRIES. A conversation that meets a full quota keeps its first line for good; the
 * owner can rename it. That is a decision, not an omission (requirements, assumption 3).
 *
 * NOT `runAgent` (D4): that one translates stream-json into the log, and leaves a process group the
 * next boot reconciles through `agentPid`. A title has no log and no meta of its own, and a stray
 * titler holds no lock.
 */

import { spawn } from 'node:child_process'
import type { Logger, Timers } from '@factotum/core'
import { CLAUDE_BIN, killGroup } from '../run.ts'
import type { SessionMeta } from '../store.ts'
import type { TitlesConfig } from '../types.ts'
import { buildTitlerArgs } from './args.ts'
import { extractTitle } from './extract.ts'
import { buildTitlePrompt } from './prompt.ts'

/** Measured at about 5 s with Haiku (spec §0.7, tasks §M): six times that is a titler that is stuck. */
export const TITLER_TIMEOUT_MS = 30_000

/** A title is a few words: more than this on stdout is not a title, and is not kept. */
const STDOUT_MAX = 8 * 1024
/** Enough stderr to say what went wrong, never a second log. */
const STDERR_MAX = 300

export interface TitlerDeps {
  readonly config: TitlesConfig
  /** `<stateDir>/titler`: empty, and never a project's folder (criterion 19). */
  readonly cwd: string
  /** The kernel's, never the global `setTimeout` (CLAUDE.md §6). */
  readonly timers: Timers
  readonly log: Logger
  /** Writes the title if there is none yet. `undefined`: the conversation is gone. */
  readonly write: (sessionId: string, title: string) => Promise<SessionMeta | undefined>
  /** The seam the engine already has for tests. Never from the configuration. */
  readonly bin?: string
  /** A test cannot wait thirty seconds. */
  readonly timeoutMs?: number
}

export interface Titler {
  /** Synchronous, returns nothing, and never throws (guardrail 6). */
  readonly start: (sessionId: string, text: string) => void
  /** Kills whatever is in flight; afterwards nothing is written. Never throws. */
  readonly stop: () => void
}

/**
 * The only way this file kills anything. `killGroup` is `process.kill(-pid)`, which THROWS when the
 * group is already gone — and here it runs inside a timer's callback. The same guard as
 * `AgentRun.kill` (`run.ts`).
 */
export function killQuietly(pid: number | undefined): void {
  if (pid === undefined) return
  try {
    killGroup(pid)
  } catch {
    // Already gone between deciding to kill it and doing so: the outcome that was wanted.
  }
}

interface InFlight {
  readonly pid: number | undefined
  readonly timer: Disposable
}

export function createTitler(deps: TitlerDeps): Titler {
  const { config, log } = deps
  const timeoutMs = deps.timeoutMs ?? TITLER_TIMEOUT_MS
  const inFlight = new Set<InFlight>()
  let stopped = false

  /** What one run came to, decided ONCE per process. */
  async function conclude(
    sessionId: string,
    startedAt: number,
    outcome: { timedOut: boolean; code: number | null; stdout: string; stderr: string; spawnError: Error | undefined },
  ): Promise<void> {
    if (stopped) return
    if (outcome.timedOut) {
      log.warn(`titler gave up after ${Math.round(timeoutMs / 1000)} s (session ${sessionId})`)
      return
    }
    if (outcome.spawnError !== undefined || outcome.code !== 0) {
      const why = outcome.spawnError?.message ?? `code ${outcome.code}`
      log.warn(`titler failed with ${why} (session ${sessionId}): ${outcome.stderr.trim().slice(0, STDERR_MAX)}`)
      return
    }
    const title = extractTitle(outcome.stdout)
    if (title === null) {
      log.info(`no title for session ${sessionId}: its first message does not say what it is about`)
      return
    }
    const written = await deps.write(sessionId, title)
    if (written === undefined) {
      log.info(`session ${sessionId} was deleted before its title`)
      return
    }
    // The happy path leaves its line, and it is not decoration: it is how the time is measured in
    // production (criterion 2). The title, never the prompt (guardrail 8).
    log.info(`session ${sessionId} titled in ${Date.now() - startedAt} ms: ${title}`)
  }

  function run(sessionId: string, text: string): void {
    const startedAt = Date.now()
    const child = spawn(
      deps.bin ?? CLAUDE_BIN,
      [...buildTitlerArgs({ prompt: buildTitlePrompt(text), model: config.model, effort: config.effort })],
      // stdin CLOSED: left open, the CLI waits three seconds for it (spec §0.7). Its own group, so
      // the timeout kills the whole of it.
      { cwd: deps.cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: true },
    )

    let stdout = ''
    let stderr = ''
    let timedOut = false
    let spawnError: Error | undefined
    let settled = false

    const flight: InFlight = {
      pid: child.pid,
      timer: deps.timers.setTimeout(() => {
        timedOut = true
        killQuietly(child.pid)
      }, timeoutMs),
    }
    inFlight.add(flight)

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < STDOUT_MAX) stdout += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < STDERR_MAX * 2) stderr += chunk.toString('utf8')
    })

    // ONE DECISION PER PROCESS. A binary that is not there emits `error` AND `close` (measured,
    // spec §0.5); deciding on both would warn twice and drop the flight twice.
    const settle = (code: number | null): void => {
      if (settled) return
      settled = true
      flight.timer[Symbol.dispose]()
      inFlight.delete(flight)
      void conclude(sessionId, startedAt, { timedOut, code, stdout, stderr, spawnError }).catch((error: unknown) =>
        log.warn(`titler could not finish session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`),
      )
    }

    // Registered with the rest, before any event can fire: an `error` with no listener on a
    // ChildProcess is an unhandled 'error' event, which ends the process (`run.ts`).
    child.on('error', (error: Error) => {
      spawnError = error
      if (child.pid === undefined) settle(null)
    })
    child.on('close', (code: number | null) => settle(code))
  }

  return {
    start: (sessionId, text) => {
      try {
        if (!config.enabled || stopped || text.trim() === '') return
        run(sessionId, text)
      } catch (error) {
        // `spawn` itself can throw — a NUL in an argument does (spec §0.5). The conversation is
        // already running; it simply keeps its first line.
        log.warn(`titler could not start for session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`)
      }
    },

    stop: () => {
      try {
        stopped = true
        for (const flight of inFlight) {
          flight.timer[Symbol.dispose]()
          killQuietly(flight.pid)
        }
        inFlight.clear()
      } catch (error) {
        log.warn(`titler did not stop cleanly: ${error instanceof Error ? error.message : String(error)}`)
      }
    },
  }
}
