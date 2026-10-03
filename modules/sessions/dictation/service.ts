/**
 * Dictation, put together once in `start()` (spec 2026-10-03, D6): is it on, and if so, audio → text.
 *
 * `createDictation` NEVER THROWS. It runs inside the module's `start()`, and an exception there disables
 * the whole sessions module. A bad block, a missing key, a provider that will not build — each is
 * dictation off, with a reason the screen can show.
 *
 * THE KEY IS READ ONCE. Changing it means restarting the daemon (risk 12).
 *
 * THE AUDIO IS READ, NEVER KEPT: the kernel wrote it under `.incoming/` and deletes it when the handler
 * returns. Nothing here moves, copies or writes it (criterion 17).
 */

import { readFile } from 'node:fs/promises'
import type { Logger, ReceivedFile, Timers } from '@factotum/core'
import { parseDictation } from './config.ts'
import { createGroqProvider, ProviderError, type GroqOptions, type Provider } from './groq.ts'
import { baseType, normalizeTranscript, NOT_CONFIGURED, PROVIDER_TIMEOUT_MS, type ProviderFailure } from './shape.ts'
import { buildPrompt } from './vocabulary.ts'

export type Transcribed =
  | { readonly kind: 'ok'; readonly text: string }
  | { readonly kind: 'invalid'; readonly reason: string }
  | { readonly kind: 'provider'; readonly failure: ProviderFailure; readonly message: string }

export type DictationState =
  | {
      readonly kind: 'on'
      /** Throws only when the HOST fails (the audio cannot be read): that is a 500, not the provider. */
      readonly transcribe: (file: ReceivedFile, rawType: string | undefined) => Promise<Transcribed>
    }
  | { readonly kind: 'off'; readonly reason: string }

export interface DictationDeps {
  /** `ctx.config.dictation`, uninterpreted. */
  readonly raw: unknown
  readonly log: Logger
  readonly timers: Timers
  readonly readKey?: (path: string) => Promise<string>
  readonly readAudio?: (path: string) => Promise<Uint8Array>
  readonly provider?: (options: GroqOptions) => Provider
  readonly clock?: () => number
}

const readText = (path: string): Promise<string> => readFile(path, 'utf8')

export async function createDictation(deps: DictationDeps): Promise<DictationState> {
  try {
    return await build(deps)
  } catch {
    // Whatever escaped is a programming error in here — but start() is not the place to find out.
    deps.log.warn('dictation is off: it could not be set up')
    return { kind: 'off', reason: 'dictation is off: it could not be set up on this host' }
  }
}

async function build(deps: DictationDeps): Promise<DictationState> {
  const parsed = parseDictation(deps.raw)
  if (parsed.kind === 'absent') return { kind: 'off', reason: NOT_CONFIGURED }
  if (parsed.kind === 'invalid') {
    const reason = `dictation is off: ${parsed.reason}`
    deps.log.warn(reason)
    return { kind: 'off', reason }
  }
  const { config } = parsed

  let apiKey: string
  try {
    apiKey = (await (deps.readKey ?? readText)(config.apiKeyFile)).trim()
  } catch {
    apiKey = ''
  }
  if (apiKey === '') {
    // The path, never the contents — and never the system's message, which can quote neither but is not ours.
    const reason = `dictation is off: cannot read the API key file ${config.apiKeyFile}`
    deps.log.warn(reason)
    return { kind: 'off', reason }
  }

  const { prompt, dropped } = buildPrompt(config.vocabulary)
  if (dropped > 0) {
    deps.log.warn(`dictation: ${dropped} of ${config.vocabulary.length} vocabulary terms do not fit and are not sent; put the ones you dictate most first`)
  }

  const provider = (deps.provider ?? createGroqProvider)({
    apiKey,
    model: config.model,
    language: config.language,
    timers: deps.timers,
    timeoutMs: PROVIDER_TIMEOUT_MS,
  })
  const readAudio = deps.readAudio ?? ((path: string) => readFile(path))
  const clock = deps.clock ?? Date.now

  const transcribe = async (file: ReceivedFile, rawType: string | undefined): Promise<Transcribed> => {
    const started = clock()
    const result = await attempt(file, rawType)
    // ONE line per dictation, and only these three things (criteria 18, 34).
    const outcome = result.kind === 'provider' ? result.failure : result.kind
    deps.log.info(`dictation: ${file.bytes} bytes → ${outcome} in ${clock() - started} ms`)
    return result
  }

  const attempt = async (file: ReceivedFile, rawType: string | undefined): Promise<Transcribed> => {
    const type = baseType(rawType)
    if (type === undefined) return { kind: 'invalid', reason: 'type must be one of the audio types this host accepts (audio/webm, audio/mp4, …)' }
    const audio = await readAudio(file.path)
    try {
      return { kind: 'ok', text: normalizeTranscript(await provider.transcribe(audio, type, prompt)) }
    } catch (error) {
      if (error instanceof ProviderError) return { kind: 'provider', failure: error.code, message: error.message }
      return { kind: 'provider', failure: 'failed', message: 'the transcription provider failed' }
    }
  }

  return { kind: 'on', transcribe }
}
