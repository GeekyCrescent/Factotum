/**
 * Classifying one batch: spawn `claude`, write the prompt to stdin, wait, parse (spec 2026-10-05, D6).
 *
 * THE TITLER'S PATTERN (`packages/sessions/src/titler/index.ts`), not `runAgent`: no session log, no
 * meta, no lock. Its own process group, a timeout on the kernel's clock that kills the group, and ONE
 * decision per process.
 *
 * WITH ONE DIFFERENCE THAT MATTERS: the titler leaves stdin closed, and this writes 160 KB into it. A
 * `claude` that exits without reading it makes the write fail with EPIPE, and an `error` on a stream
 * with no listener ends the daemon. So the listener is on `child.stdin` BEFORE the first byte is
 * written (criterion 11b, guardrail 8).
 *
 * NOTHING THROWS OUT OF HERE: every path is `{ ok: false, reason }`. And no reason carries a word of
 * the prompt — reasons end up in the log and in the digest file (criterion 27).
 */

import { spawn, type ChildProcess } from 'node:child_process'
import type { Timers } from '@factotum/core'
import { CLAUDE_BIN, killGroup, killQuietly } from '@factotum/sessions'
import { buildDigestArgs } from './args.ts'
import { buildBatchPrompt, type PromptMail } from './prompt.ts'
import { BATCH_JSON_SCHEMA, verdictSchema, type Verdict } from './schema.ts'

/** A batch of 40 took 26–38 s in A2 (tasks §M). Five times that is a batch that is stuck. */
export const BATCH_TIMEOUT_MS = 3 * 60_000
/**
 * After SIGTERM, how long the group gets before SIGKILL. The batch settles only on `close`: a group
 * that ignored SIGTERM would leave the run `running` for good, and `stop()` waiting on it.
 */
export const KILL_GRACE_MS = 5_000
/** The CLI's answer for 40 mails is a few KB; past this it is not an answer. */
const STDOUT_MAX = 1024 * 1024
/** Enough of stderr to say why the CLI refused, never a second log. */
const STDERR_MAX = 200

export interface BatchUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly costUsd: number
  readonly ms: number
  readonly model: string | undefined
}

export type BatchResult =
  | { readonly ok: true; readonly verdicts: ReadonlyMap<string, Verdict>; readonly usage: BatchUsage }
  | { readonly ok: false; readonly reason: string }

export interface BatchInput {
  readonly mails: readonly PromptMail[]
  readonly today: string
  readonly model: string
  readonly effort: string | undefined
  /** `<stateDir>/run`: empty, and nobody's project. */
  readonly cwd: string
  /** The run's global cap: on abort, the group is killed (criterion 20). */
  readonly signal: AbortSignal
  readonly timers: Timers
  /** The seam for `fake-claude`. Never from the configuration. */
  readonly bin?: string
  /** A test cannot wait three minutes. */
  readonly timeoutMs?: number
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

export function classifyBatch(input: BatchInput): Promise<BatchResult> {
  const timeoutMs = input.timeoutMs ?? BATCH_TIMEOUT_MS
  if (input.signal.aborted) return Promise.resolve({ ok: false, reason: 'stopped' })

  let child: ChildProcess
  try {
    child = spawn(input.bin ?? CLAUDE_BIN, [...buildDigestArgs({ model: input.model, effort: input.effort, schema: BATCH_JSON_SCHEMA })], {
      cwd: input.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      // Its own group, so the timeout and the cap kill the whole of it.
      detached: true,
    })
  } catch (error) {
    // `spawn` itself can throw — a NUL in an argument does.
    return Promise.resolve({ ok: false, reason: `claude could not start: ${messageOf(error)}` })
  }

  return new Promise<BatchResult>((resolve) => {
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
    }, timeoutMs)
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
      resolve(conclude({ code, stdout, stderr, spawnError, stdinError, timedOut, aborted }, input, timeoutMs))
    }

    // Decoded by the stream, not per chunk: a character split across two chunks would become U+FFFD.
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      if (stdout.length < STDOUT_MAX) stdout += chunk
    })
    // Read always: a full stderr pipe would block the child. Only its start is kept, for a refusal.
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      if (stderr.length < STDERR_MAX) stderr += chunk
    })
    child.on('error', (error: Error) => {
      spawnError = error
      if (child.pid === undefined) settle(null)
    })
    child.on('close', (code: number | null) => settle(code))

    // BEFORE THE FIRST BYTE: an EPIPE here must be a failed batch, not a dead daemon (criterion 11b).
    child.stdin?.on('error', (error: Error) => {
      stdinError = error
    })
    child.stdin?.end(buildBatchPrompt({ mails: input.mails, today: input.today }))
  })
}

function conclude(outcome: Outcome, input: BatchInput, timeoutMs: number): BatchResult {
  if (outcome.aborted) return { ok: false, reason: 'stopped' }
  if (outcome.timedOut) return { ok: false, reason: `claude gave no answer within ${Math.round(timeoutMs / 1000)} s` }
  if (outcome.spawnError !== undefined) return { ok: false, reason: `claude could not start: ${outcome.spawnError.message}` }
  if (outcome.stdinError !== undefined) {
    return { ok: false, reason: `claude did not read the prompt (${codeOf(outcome.stdinError)})` }
  }
  if (outcome.code !== 0) {
    // The CLI's own complaint about its arguments (measured: a schema it refuses). It does not quote
    // the prompt, which it has not read by then; and it is cut to one line.
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
  const items = parsed.structured_output?.items
  if (!Array.isArray(items)) return { ok: false, reason: 'claude answered without the structured output' }

  // PER ITEM: one `why` over its limit leaves that ONE mail unclassified, not the forty (criterion 12).
  // An id that was not in the batch is ignored.
  const wanted = new Set(input.mails.map((mail) => mail.id))
  const verdicts = new Map<string, Verdict>()
  for (const item of items) {
    const checked = verdictSchema.safeParse(item)
    if (!checked.success || !wanted.has(checked.data.id)) continue
    const { id, ...verdict } = checked.data
    verdicts.set(id, verdict)
  }
  return { ok: true, verdicts, usage: usageOf(parsed) }
}

interface CliResult {
  readonly subtype?: string
  readonly is_error?: boolean
  readonly api_error_status?: unknown
  readonly structured_output?: { readonly items?: unknown }
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

function usageOf(parsed: CliResult): BatchUsage {
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
