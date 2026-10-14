/**
 * One run of `claude` with no conversation: spawn, prompt by stdin, wait, validate (design D5).
 *
 * THE INBOX'S PATTERN (`packages/inbox/src/classify/run.ts`), generic over the output: its own
 * process group, a timeout on the kernel's clock that kills the group (and SIGKILL after a grace),
 * ONE decision per process, and the listener on `child.stdin` BEFORE the first byte is written — a
 * `claude` that exits without reading would otherwise end the daemon with an EPIPE.
 *
 * NOTHING THROWS OUT OF HERE: every path is `{ ok: false, reason }`. And no reason carries a word of
 * the prompt or of the answer — reasons end up in the log (criterion 41).
 */

import { spawn, type ChildProcess } from 'node:child_process'
import type { Timers } from '@factotum/core'
import { CLAUDE_BIN, killGroup, killQuietly } from '@factotum/sessions'
import type { z } from 'zod'
import { buildClaudeArgs } from './args.ts'

/** After SIGTERM, how long the group gets before SIGKILL: a run settles only on `close`. */
export const KILL_GRACE_MS = 5_000
/** A card or seven suggestions are a few KB; past this it is not an answer (design D5). */
const STDOUT_MAX = 256 * 1024
/** Enough of stderr to say why the CLI refused, never a second log. */
const STDERR_MAX = 200

export interface RunUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly costUsd: number
  readonly ms: number
  readonly model: string | undefined
}

export type RunResult<T> = { readonly ok: true; readonly value: T; readonly usage: RunUsage } | { readonly ok: false; readonly reason: string }

export interface RunInput<T> {
  readonly prompt: string
  /** The draft-07 JSON Schema handed to `--json-schema`. */
  readonly jsonSchema: string
  /** What the structured output must pass, here, whatever the CLI promised. */
  readonly output: z.ZodType<T>
  readonly model: string
  readonly effort: string | undefined
  /** `<stateDir>/run`: empty, and nobody's project. */
  readonly cwd: string
  readonly timers: Timers
  /** `stop()` aborts it: the group is killed. */
  readonly signal: AbortSignal
  readonly timeoutMs: number
  /** The seam for `fake-claude`. Never from the configuration. */
  readonly bin?: string
}

interface Outcome {
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
  readonly spawnError: Error | undefined
  readonly stdinError: Error | undefined
  readonly timedOut: boolean
  readonly aborted: boolean
}

export function runClaude<T>(input: RunInput<T>): Promise<RunResult<T>> {
  if (input.signal.aborted) return Promise.resolve({ ok: false, reason: 'stopped' })

  let child: ChildProcess
  try {
    child = spawn(input.bin ?? CLAUDE_BIN, [...buildClaudeArgs({ model: input.model, effort: input.effort, schema: input.jsonSchema })], {
      cwd: input.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      // Its own group, so the timeout and `stop` kill the whole of it.
      detached: true,
    })
  } catch (error) {
    // `spawn` itself can throw — a NUL in an argument does.
    return Promise.resolve({ ok: false, reason: `claude could not start: ${messageOf(error)}` })
  }

  return new Promise<RunResult<T>>((resolve) => {
    let stdout = ''
    let stderr = ''
    let spawnError: Error | undefined
    let stdinError: Error | undefined
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
    input.signal.addEventListener('abort', onAbort, { once: true })

    // ONE DECISION PER PROCESS: a binary that is not there emits `error` AND `close`.
    const settle = (code: number | null): void => {
      if (settled) return
      settled = true
      timer[Symbol.dispose]()
      grace?.[Symbol.dispose]()
      input.signal.removeEventListener('abort', onAbort)
      resolve(conclude({ code, stdout, stderr, spawnError, stdinError, timedOut, aborted }, input))
    }

    // Decoded by the stream, not per chunk: a character split across two chunks would become U+FFFD.
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      if (stdout.length < STDOUT_MAX) stdout += chunk
    })
    // Read always: a full stderr pipe would block the child.
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      if (stderr.length < STDERR_MAX) stderr += chunk
    })
    child.on('error', (error: Error) => {
      spawnError = error
      if (child.pid === undefined) settle(null)
    })
    child.on('close', (code: number | null) => settle(code))

    // BEFORE THE FIRST BYTE: an EPIPE here must be a failed run, not a dead daemon.
    child.stdin?.on('error', (error: Error) => {
      stdinError = error
    })
    child.stdin?.end(input.prompt)
  })
}

function conclude<T>(outcome: Outcome, input: RunInput<T>): RunResult<T> {
  if (outcome.aborted) return { ok: false, reason: 'stopped' }
  if (outcome.timedOut) return { ok: false, reason: `claude gave no answer within ${Math.round(input.timeoutMs / 1000)} s` }
  if (outcome.spawnError !== undefined) return { ok: false, reason: `claude could not start: ${outcome.spawnError.message}` }
  if (outcome.stdinError !== undefined) return { ok: false, reason: `claude did not read the prompt (${codeOf(outcome.stdinError)})` }
  if (outcome.code !== 0) {
    // The CLI's own complaint about its arguments. It does not quote the prompt, which it has not
    // read by then; and it is cut to one line.
    const said = outcome.stderr.trim().split('\n')[0]?.slice(0, STDERR_MAX) ?? ''
    return { ok: false, reason: `claude exited with code ${outcome.code}${said === '' ? '' : `: ${said}`}` }
  }

  let parsed: CliResult
  try {
    parsed = JSON.parse(outcome.stdout) as CliResult
  } catch {
    return { ok: false, reason: 'claude answered something that is not JSON' }
  }
  if (parsed.is_error === true || parsed.subtype !== 'success') {
    return { ok: false, reason: `claude failed: ${String(parsed.api_error_status ?? parsed.subtype ?? 'unknown')}` }
  }
  const checked = input.output.safeParse(parsed.structured_output)
  if (!checked.success) return { ok: false, reason: 'claude answered outside the schema' }
  return { ok: true, value: checked.data, usage: usageOf(parsed) }
}

interface CliResult {
  readonly subtype?: string
  readonly is_error?: boolean
  readonly api_error_status?: unknown
  readonly structured_output?: unknown
  readonly total_cost_usd?: number
  readonly duration_ms?: number
  readonly usage?: {
    readonly input_tokens?: number
    readonly cache_creation_input_tokens?: number
    readonly cache_read_input_tokens?: number
    readonly output_tokens?: number
  }
  readonly modelUsage?: Readonly<Record<string, unknown>>
}

function usageOf(parsed: CliResult): RunUsage {
  const usage = parsed.usage ?? {}
  return {
    inputTokens: (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0),
    outputTokens: usage.output_tokens ?? 0,
    costUsd: parsed.total_cost_usd ?? 0,
    ms: parsed.duration_ms ?? 0,
    model: Object.keys(parsed.modelUsage ?? {})[0],
  }
}

function codeOf(error: Error): string {
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : error.message
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
