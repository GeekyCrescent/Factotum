/**
 * One run of `claude` with no conversation: spawn, prompt by stdin, wait, validate (design D10).
 *
 * COPIED FROM packages/tasks/src/ai (`run.ts`; requirements §0.2, S11) — its own process group, a
 * timeout on the kernel's clock that kills the group (SIGKILL after a grace), ONE decision per
 * process, the listener on `child.stdin` before the first byte — with the TWO CHANGES of D10:
 *
 * 1. THE USAGE LIMIT IS READ BEFORE THE EXIT CODE. The original returned `claude exited with code N`
 *    as soon as `code !== 0`, without reading stdout. A3 (13-nov, CLI 2.1.289) measured that an API
 *    error in `-p --output-format json` exits with code 1 AND the whole JSON on stdout, with
 *    `subtype: "success"`. So stdout is parsed first, quietly; a limit (`isLimit`) is `kind: 'limit'`
 *    whatever the code, with `resetsAt` when the text gives an hour. `subtype` is never read:
 *    `is_error` decides, and a non-limit error says its status rather than a bare exit code.
 * 2. `RunUsage` COUNTS THE CACHE APART (`cacheCreationTokens`, `cacheReadTokens`): the original
 *    summed them into `inputTokens`, which hid that the stdin variant did not cache (A4).
 *
 * NOTHING THROWS OUT OF HERE: every path is `{ ok: false, kind, reason }`. NO REASON CARRIES A WORD
 * OF THE PROMPT, OF THE ANSWER, OF THE CLI'S `result` OR OF STDERR (criterion 41): of a limit's text
 * only the hour is taken, and never stored.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import type { Timers } from '@factotum/core'
import { CLAUDE_BIN, killGroup, killQuietly } from '@factotum/sessions'
import type { z } from 'zod'
import type { RunUsage } from '../types.ts'
import { buildClaudeArgs } from './args.ts'

export type { RunUsage } from '../types.ts'

/** After SIGTERM, how long the group gets before SIGKILL: a run settles only on `close`. */
export const KILL_GRACE_MS = 5_000
/** A CV is tens of KB; past this it is not an answer. */
const STDOUT_MAX = 1024 * 1024
/** The reason of a limit: ours, never the CLI's text. */
export const LIMIT_REASON = 'claude hit its usage limit'

export type RunFailure =
  | { readonly ok: false; readonly kind: 'failed'; readonly reason: string }
  /** `resetsAt`: ISO, when the CLI said the hour; absent → the caller pauses 30 min (D10). */
  | { readonly ok: false; readonly kind: 'limit'; readonly reason: string; readonly resetsAt?: string }

export type RunResult<T> = { readonly ok: true; readonly value: T; readonly usage: RunUsage } | RunFailure

export interface RunInput<T> {
  /** What varies (profile, rules, the opportunity): by stdin, where `ps` cannot see it. */
  readonly prompt: string
  /** The fixed prefix as a file (A4); absent = none. */
  readonly systemFile?: string | undefined
  /** The draft-07 JSON Schema handed to `--json-schema`. */
  readonly jsonSchema: string
  /** What the structured output must pass, here, whatever the CLI promised. */
  readonly output: z.ZodType<T>
  readonly model: string
  readonly effort: string | undefined
  /** `<stateDir>/run`: empty, and nobody's project. */
  readonly cwd: string
  readonly timers: Timers
  /** For `resetsAt`: the next occurrence of the hour the CLI names. */
  readonly now: () => Date
  /** `stop()` aborts it: the group is killed. */
  readonly signal: AbortSignal
  readonly timeoutMs: number
  /** The seam for `fake-claude`. Never from the configuration. */
  readonly bin?: string
}

interface Outcome {
  readonly code: number | null
  readonly stdout: string
  readonly spawnError: Error | undefined
  readonly stdinError: Error | undefined
  readonly timedOut: boolean
  readonly aborted: boolean
}

const failed = (reason: string): RunFailure => ({ ok: false, kind: 'failed', reason })

export function runClaude<T>(input: RunInput<T>): Promise<RunResult<T>> {
  if (input.signal.aborted) return Promise.resolve(failed('stopped'))

  let child: ChildProcess
  try {
    const args = buildClaudeArgs({ model: input.model, effort: input.effort, schema: input.jsonSchema, systemFile: input.systemFile })
    child = spawn(input.bin ?? CLAUDE_BIN, [...args], {
      cwd: input.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      // Its own group, so the timeout and `stop` kill the whole of it.
      detached: true,
    })
  } catch (error) {
    // `spawn` itself can throw — a NUL in an argument does.
    return Promise.resolve(failed(`claude could not start: ${messageOf(error)}`))
  }

  return new Promise<RunResult<T>>((resolve) => {
    let stdout = ''
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
      resolve(conclude({ code, stdout, spawnError, stdinError, timedOut, aborted }, input))
    }

    // Decoded by the stream, not per chunk: a character split across two chunks would become U+FFFD.
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

    // BEFORE THE FIRST BYTE: an EPIPE here must be a failed run, not a dead daemon.
    child.stdin?.on('error', (error: Error) => {
      stdinError = error
    })
    child.stdin?.end(input.prompt)
  })
}

/** What the CLI writes, as far as it is read — every field `unknown`, read only through the helpers. */
export interface CliResult {
  /** Written by the CLI, NEVER read: A3 measured `"success"` on an API error. */
  readonly subtype?: unknown
  readonly is_error?: unknown
  readonly api_error_status?: unknown
  readonly terminal_reason?: unknown
  readonly result?: unknown
  readonly structured_output?: unknown
  readonly total_cost_usd?: unknown
  readonly duration_ms?: unknown
  readonly usage?: unknown
  readonly modelUsage?: unknown
}

type Parsed = { readonly kind: 'result'; readonly value: CliResult } | { readonly kind: 'not-json' } | { readonly kind: 'not-result' }

/** stdout, parsed without throwing. */
function parse(stdout: string): Parsed {
  let json: unknown
  try {
    json = JSON.parse(stdout)
  } catch {
    return { kind: 'not-json' }
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return { kind: 'not-result' }
  return { kind: 'result', value: json as CliResult }
}

/** A limit, said by our words, with the hour when the CLI gave one. */
function limitOf(parsed: CliResult, now: Date): RunFailure {
  const resetsAt = resetsAtOf(parsed.result, now)
  return resetsAt === undefined ? { ok: false, kind: 'limit', reason: LIMIT_REASON } : { ok: false, kind: 'limit', reason: LIMIT_REASON, resetsAt }
}

function conclude<T>(outcome: Outcome, input: RunInput<T>): RunResult<T> {
  if (outcome.aborted) return failed('stopped')
  if (outcome.timedOut) return failed(`claude gave no answer within ${Math.round(input.timeoutMs / 1000)} s`)
  if (outcome.spawnError !== undefined) return failed(`claude could not start: ${outcome.spawnError.message}`)
  if (outcome.stdinError !== undefined) return failed(`claude did not read the prompt (${codeOf(outcome.stdinError)})`)

  // BEFORE THE EXIT CODE (D10 change 1): the real CLI exits 1 with its JSON on stdout.
  const parsed = parse(outcome.stdout)
  if (parsed.kind === 'result' && isLimit(parsed.value)) return limitOf(parsed.value, input.now())
  if (parsed.kind === 'result' && parsed.value.is_error === true) {
    return failed(`claude failed: ${statusOf(parsed.value.api_error_status ?? parsed.value.terminal_reason)}`)
  }
  if (outcome.code !== 0) return failed(`claude exited with code ${outcome.code}`)
  if (parsed.kind === 'not-json') return failed('claude answered something that is not JSON')
  if (parsed.kind === 'not-result') return failed('claude answered something that is not a result')

  const checked = input.output.safeParse(parsed.value.structured_output)
  if (!checked.success) return failed('claude answered outside the schema')
  return { ok: true, value: checked.data, usage: usageOf(parsed.value) }
}

/** The texts the CLI uses for a limit (A3: «You've hit your session limit · resets 10am (…)»). */
const LIMIT_TEXT = /hit your .*limit|usage limit|limit reached/i
const TOO_MANY_REQUESTS = 429

/** A usage limit: status 429, or an error whose text says so. Pure; `subtype` is never read (A3). */
export function isLimit(parsed: CliResult): boolean {
  if (parsed.api_error_status === TOO_MANY_REQUESTS) return true
  return parsed.is_error === true && typeof parsed.result === 'string' && LIMIT_TEXT.test(parsed.result)
}

const RESETS = /resets (\d{1,2})(?::(\d{2}))?\s*(am|pm) \(([A-Za-z_/]+)\)/i
const MINUTE_MS = 60_000
const DAY_MS = 86_400_000
/** A margin past the hour the CLI names, so the probe does not land on the edge. */
const RESET_MARGIN_MS = MINUTE_MS
const HOURS_ON_A_DIAL = 12

/** The wall clock of `timeZone` at `instant`, as if it were UTC, minus the instant: the zone's offset. */
function offsetAt(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(instant))
  const part = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? 0)
  return Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'), part('minute'), part('second')) - instant
}

/** The instant whose wall clock in `timeZone` reads `wall` (ms as if UTC); two passes settle a DST edge. */
function instantOf(wall: number, timeZone: string): number {
  const first = wall - offsetAt(wall, timeZone)
  return wall - offsetAt(first, timeZone)
}

/** The 24 h hour of a 12 h dial, or null when the dial has no such hour. */
function hourOf(dial: number, meridiem: string): number | null {
  if (dial < 1 || dial > HOURS_ON_A_DIAL) return null
  return (dial % HOURS_ON_A_DIAL) + (meridiem.toLowerCase() === 'pm' ? HOURS_ON_A_DIAL : 0)
}

/**
 * «resets H[:MM]am|pm (Zone)» → the next occurrence of that wall-clock time in that IANA zone, plus a
 * minute, ISO. Undefined when the text has no hour, the hour is not one, or `Intl` does not know the
 * zone: the caller pauses 30 min (D10). Pure.
 */
export function resetsAtOf(result: unknown, now: Date): string | undefined {
  if (typeof result !== 'string') return undefined
  const match = RESETS.exec(result)
  if (match === null) return undefined
  const [, dial = '', minutes = '0', meridiem = '', timeZone = ''] = match
  const hour = hourOf(Number(dial), meridiem)
  const minute = Number(minutes)
  if (hour === null || minute > 59) return undefined
  try {
    const local = new Date(now.getTime() + offsetAt(now.getTime(), timeZone))
    const wall = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), hour, minute)
    const today = instantOf(wall, timeZone)
    const next = today > now.getTime() ? today : instantOf(wall + DAY_MS, timeZone)
    return new Date(next + RESET_MARGIN_MS).toISOString()
  } catch {
    // `Intl` refuses a zone it does not know with a RangeError.
    return undefined
  }
}

/** A finite number, or 0: the usage is for the log, and a log line must never throw. */
function numberOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** A status for a reason: a number or a short word, never free text of the CLI's. */
function statusOf(value: unknown): string {
  if (typeof value === 'number') return String(value)
  return typeof value === 'string' && /^[a-z_]{1,40}$/.test(value) ? value : 'unknown'
}

function usageOf(parsed: CliResult): RunUsage {
  const usage = (typeof parsed.usage === 'object' && parsed.usage !== null ? parsed.usage : {}) as Readonly<Record<string, unknown>>
  const models = typeof parsed.modelUsage === 'object' && parsed.modelUsage !== null ? Object.keys(parsed.modelUsage) : []
  return {
    inputTokens: numberOf(usage.input_tokens),
    cacheCreationTokens: numberOf(usage.cache_creation_input_tokens),
    cacheReadTokens: numberOf(usage.cache_read_input_tokens),
    outputTokens: numberOf(usage.output_tokens),
    costUsd: numberOf(parsed.total_cost_usd),
    ms: numberOf(parsed.duration_ms),
    model: models[0],
  }
}

function codeOf(error: Error): string {
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : error.message
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
