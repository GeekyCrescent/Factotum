/**
 * One run of a host binary — Chromium, `pdfinfo`, `pdftoppm` — in its own process group, with a
 * timeout on the injected timers (design D5 steps 6–7; tasks H3, H4).
 *
 * COPIED FROM packages/tasks/src/ai/run.ts (the spawning half of `runClaude`, S11), without the
 * prompt and the JSON: `detached: true` so the child leads its own group; the timeout and the signal
 * kill THE GROUP (`killQuietly`), then SIGKILL after a grace; ONE decision per process, on `close` —
 * a binary that is not there emits `error` and may emit `close` too.
 *
 * NOTHING THROWS OUT OF HERE: every path is a `Result`. A REASON NEVER CARRIES STDERR: Poppler's
 * names the path, Chromium's is noise we cannot vouch for; stderr is drained and dropped.
 */

import { spawn, type ChildProcess } from 'node:child_process'

import type { Timers } from '@factotum/core'
import { killGroup, killQuietly } from '@factotum/sessions'

import { fail, ok, type Result } from '../types.ts'

/** After SIGTERM, how long the group gets before SIGKILL (the value of `tasks`). */
export const KILL_GRACE_MS = 5_000
/** `pdfinfo` prints < 1 KB; past this it is not an answer. */
const STDOUT_MAX = 64 * 1024

export interface ProcessInput {
  /** For the reasons: «pdfinfo exited with code 1». */
  readonly name: string
  readonly bin: string
  readonly args: readonly string[]
  readonly timers: Timers
  readonly timeoutMs: number
  /** `stop()` aborts it: the group is killed. */
  readonly signal?: AbortSignal
}

interface Outcome {
  readonly code: number | null
  readonly stdout: string
  readonly spawnError: Error | undefined
  readonly timedOut: boolean
  readonly aborted: boolean
}

const codeOf = (error: unknown): string => {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : 'error'
}

/** Resolves to the process's stdout when it exits 0. */
export function runProcess(input: ProcessInput): Promise<Result<string>> {
  if (input.signal?.aborted === true) return Promise.resolve(fail('module-error', 'stopped'))
  let child: ChildProcess
  try {
    // Its own group, so the timeout and `stop` kill the whole of it.
    child = spawn(input.bin, [...input.args], { stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  } catch (error) {
    // `spawn` itself throws on a NUL in an argument.
    return Promise.resolve(fail('module-error', `${input.name} could not start (${codeOf(error)})`))
  }
  return new Promise((resolve) => settleOn(child, input, resolve))
}

function settleOn(child: ChildProcess, input: ProcessInput, resolve: (result: Result<string>) => void): void {
  let stdout = ''
  let spawnError: Error | undefined
  let timedOut = false
  let aborted = false
  let settled = false
  let grace: Disposable | undefined

  const kill = (): void => {
    killQuietly(child.pid)
    grace ??= input.timers.setTimeout(() => {
      try {
        if (child.pid !== undefined) killGroup(child.pid, 'SIGKILL')
      } catch {
        // Already gone: what was wanted.
      }
    }, KILL_GRACE_MS)
  }
  const timer = input.timers.setTimeout(() => {
    timedOut = true
    kill()
  }, input.timeoutMs)
  const onAbort = (): void => {
    aborted = true
    kill()
  }
  input.signal?.addEventListener('abort', onAbort, { once: true })

  const settle = (code: number | null): void => {
    if (settled) return
    settled = true
    timer[Symbol.dispose]()
    grace?.[Symbol.dispose]()
    input.signal?.removeEventListener('abort', onAbort)
    resolve(conclude({ code, stdout, spawnError, timedOut, aborted }, input))
  }

  child.stdout?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => {
    if (stdout.length < STDOUT_MAX) stdout += chunk
  })
  // Read always: a full stderr pipe would block the child.
  child.stderr?.resume()
  child.on('error', (error: Error) => {
    spawnError = error
    if (child.pid === undefined) settle(null)
  })
  child.on('close', (code: number | null) => settle(code))
}

function conclude(outcome: Outcome, input: ProcessInput): Result<string> {
  if (outcome.aborted) return fail('module-error', 'stopped')
  if (outcome.timedOut) return fail('module-error', `${input.name} gave no answer within ${Math.round(input.timeoutMs / 1000)} s`)
  if (outcome.spawnError !== undefined) return fail('module-error', `${input.name} could not start (${codeOf(outcome.spawnError)})`)
  if (outcome.code !== 0) return fail('module-error', `${input.name} exited with code ${outcome.code}`)
  return ok(outcome.stdout)
}
