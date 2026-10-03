/**
 * The one transcription provider, behind an interface (spec 2026-10-03, D4).
 *
 * No registry of providers, no factory, no fallback. The interface exists so `service.ts` can be tested
 * without the network, and so a second provider would be a sibling file — NOT so that a config edit
 * switches providers: a different one means a different endpoint, a different key and a wider schema.
 *
 * NOTHING THAT PASSES THROUGH HERE IS LOGGED OR QUOTED: not the audio, not the prompt, not the text, not
 * what the provider says in an error. Only a status code makes it into a message (criterion 18).
 */

import type { Timers } from '@factotum/core'
import { AUDIO_TYPES, type ProviderFailure } from './shape.ts'

const ENDPOINT = 'https://api.groq.com/openai/v1/audio/transcriptions'

/** The API refuses a longer prompt with a 400 (Jarvis D1). `buildPrompt` stays well under; this is a fence. */
const PROVIDER_PROMPT_LIMIT = 896

/**
 * Fields declared, NOT parameter properties: `node --test` runs this file by stripping its types, and
 * `constructor(readonly code …)` is not strippable — Node refuses it with ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX.
 * Same shape as `BootError` in the kernel.
 */
export class ProviderError extends Error {
  override readonly name = 'ProviderError'
  readonly code: ProviderFailure

  constructor(code: ProviderFailure, message: string) {
    super(message)
    this.code = code
  }
}

export interface Provider {
  /** `type` is one of `AUDIO_TYPES`. Throws `ProviderError`, never anything else. */
  readonly transcribe: (audio: Uint8Array, type: string, prompt: string) => Promise<string>
}

export interface GroqOptions {
  readonly apiKey: string
  readonly model: string
  readonly language: string | undefined
  /** `ctx.timers`: the kernel's clock, so a test can advance it and a stop can dispose it (CLAUDE.md §6). */
  readonly timers: Timers
  readonly timeoutMs: number
  readonly fetch?: typeof globalThis.fetch
}

export function createGroqProvider(options: GroqOptions): Provider {
  const doFetch = options.fetch ?? globalThis.fetch

  return {
    transcribe: async (audio, type, prompt) => {
      const extension = AUDIO_TYPES[type]
      // Defence in depth: the service has already checked the type.
      if (extension === undefined) throw new ProviderError('failed', 'the transcription provider does not take that audio type')

      const form = new FormData()
      // A copy over an ArrayBuffer of its own: a Buffer is typed over ArrayBufferLike, which a BlobPart
      // does not accept (Jarvis D5). At most 4 MiB, once per dictation.
      const bytes = new Uint8Array(audio.byteLength)
      bytes.set(audio)
      form.append('file', new Blob([bytes], { type }), `dictation.${extension}`)
      form.append('model', options.model)
      form.append('response_format', 'json')
      // The lever against inventing words over noise, and a prompt makes that tendency worse.
      form.append('temperature', '0')
      if (options.language !== undefined) form.append('language', options.language)
      if (prompt !== '') form.append('prompt', prompt.slice(0, PROVIDER_PROMPT_LIMIT))

      const controller = new AbortController()
      let timedOut = false
      const timer = options.timers.setTimeout(() => {
        timedOut = true
        controller.abort()
      }, options.timeoutMs)

      let response: Response
      try {
        response = await doFetch(ENDPOINT, {
          method: 'POST',
          headers: { authorization: `Bearer ${options.apiKey}` },
          body: form,
          signal: controller.signal,
        })
      } catch {
        // The system's message is not passed on: it can carry the URL.
        throw new ProviderError('failed', timedOut ? 'the transcription provider took too long' : 'could not reach the transcription provider')
      } finally {
        timer[Symbol.dispose]()
      }

      // A fetch that does not throw did not necessarily go well — and a 401 must not read as a microphone.
      if (!response.ok) throw failureFor(response.status)

      const data = (await response.json().catch(() => undefined)) as { text?: unknown } | undefined
      if (typeof data?.text !== 'string') throw new ProviderError('failed', 'the transcription provider answered something unexpected')
      return data.text
    },
  }
}

function failureFor(status: number): ProviderError {
  if (status === 401 || status === 403) return new ProviderError('credential', 'the transcription provider rejected the API key')
  if (status === 429) return new ProviderError('quota', "the transcription provider's quota is used up")
  return new ProviderError('failed', `the transcription provider answered ${status}`)
}
