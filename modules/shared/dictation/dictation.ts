/**
 * Dictation in the composer, the pure part (spec 2026-10-03-dictado-por-voz, D9): is it available, what
 * the transcript does to the text, which container to record, what to do with a recording, and what to
 * say when it goes wrong.
 *
 * No DOM here — `modules/` type-checks without it — and nothing from `apps/web`: answers are read
 * STRUCTURALLY, `status` and `body`, the way `errorText` in `attachments.ts` does.
 *
 * THE SCREEN DECIDES BY THE BODY, NEVER BY THE STATUS ALONE. The provider failing is a 502 carrying
 * `dictation.failure`; `tailscale serve` with the daemon down is a 502 in plain text.
 */

export type DictationAvailability =
  | { readonly kind: 'on'; readonly maxSeconds: number; readonly maxBytes: number }
  | { readonly kind: 'off'; readonly reason: string }
  /** A 404, or a shape this screen does not know: a daemon from before dictation. */
  | { readonly kind: 'old' }
  /** No answer, a restart, tailscale: asked again on the next tap. */
  | { readonly kind: 'unreachable' }

/** The container to record, in order of preference. The server's list decides what it accepts. */
export const RECORD_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'] as const
/** Longer than the provider's own 20 s, so normally the server's written reason wins. */
export const CLIENT_WAIT_MS = 25_000
/** Normalised peak. Jarvis's; on the owner's phone silence measured exactly 0 (A3). */
export const VOICE_THRESHOLD = 0.02
/** Shorter than this is a double tap, not a dictation. */
export const MIN_RECORD_MS = 1_000
export const BITRATE = 24_000
/** The meter samples on an interval, not on animation frames. */
export const VOICE_SAMPLE_MS = 100

export type DictationProblem =
  | 'credential'
  | 'quota'
  | 'provider'
  | 'timeout'
  | 'unreachable'
  | 'too-large'
  | 'host'
  | 'off'
  | 'old'
  | 'denied'
  | 'no-microphone'
  | 'unsupported'
  | 'nothing-heard'
  | 'unknown'

interface Failure {
  readonly status: number
  readonly body: unknown
  readonly message: string | undefined
}

function failureOf(cause: unknown): Failure {
  const raw = cause as { status?: unknown; body?: unknown; message?: unknown } | null | undefined
  return {
    status: typeof raw?.status === 'number' ? raw.status : 0,
    body: raw?.body,
    message: typeof raw?.message === 'string' && raw.message !== '' ? raw.message : undefined,
  }
}

const UNREACHABLE = new Set([0, 502, 503, 504])

function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

export function dictationOf(outcome: { readonly reply: unknown } | { readonly error: unknown }): DictationAvailability {
  if ('error' in outcome) return failureOf(outcome.error).status === 404 ? { kind: 'old' } : { kind: 'unreachable' }
  const reply = outcome.reply as { on?: { maxSeconds?: unknown; maxBytes?: unknown }; off?: unknown } | null | undefined
  if (typeof reply?.off === 'string') return { kind: 'off', reason: reply.off }
  const on = reply?.on
  if (typeof on === 'object' && on !== null && positive(on.maxSeconds) && positive(on.maxBytes)) {
    return { kind: 'on', maxSeconds: on.maxSeconds, maxBytes: on.maxBytes }
  }
  return { kind: 'old' }
}

/** One space between what was there and what was said; nothing said leaves the SAME string (criterion 20). */
export function appendDictation(current: string, transcript: string): string {
  const said = transcript.trim()
  if (said === '') return current
  if (current === '' || /\s$/.test(current)) return current + said
  return `${current} ${said}`
}

export function pickType(isSupported: (type: string) => boolean): string | undefined {
  return RECORD_TYPES.find((type) => isSupported(type))
}

export function formatClock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds))
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
}

/**
 * What to do with what was recorded (criteria 34, 36, 37). An unreliable meter that heard nothing still
 * UPLOADS: when in doubt, transcribe — the text never sends itself.
 */
export function afterRecording(recording: {
  readonly durationMs: number
  readonly heardVoice: boolean
  readonly meterReliable: boolean
  readonly bytes: number
  readonly maxBytes: number
}): 'discard' | 'nothing-heard' | 'too-large' | 'upload' {
  if (recording.durationMs < MIN_RECORD_MS) return 'discard'
  if (recording.meterReliable && !recording.heardVoice) return 'nothing-heard'
  if (recording.bytes > recording.maxBytes) return 'too-large'
  return 'upload'
}

/** What a failed `POST dictation` means. Every answer has a destination; `unknown` is the last one. */
export function dictationProblemOf(cause: unknown): DictationProblem {
  const { status, body } = failureOf(cause)
  const dictation = (body as { dictation?: { failure?: unknown; off?: unknown } } | null | undefined)?.dictation
  if (dictation?.failure === 'credential') return 'credential'
  if (dictation?.failure === 'quota') return 'quota'
  if (typeof dictation?.failure === 'string') return 'provider'
  if (typeof dictation?.off === 'string') return 'off'
  if (status === 413) return 'too-large'
  if (status === 500) return 'host'
  if (status === 404) return 'old'
  if (UNREACHABLE.has(status)) return 'unreachable'
  return 'unknown'
}

/** The server's own words, for `off` and `unknown`. */
export function dictationDetailOf(cause: unknown): string | undefined {
  const { body, message } = failureOf(cause)
  const off = (body as { dictation?: { off?: unknown } } | null | undefined)?.dictation?.off
  return typeof off === 'string' ? off : message
}

/** What `getUserMedia` refused with. Only a refusal is "denied"; everything else is the device. */
export function microphoneProblemOf(error: unknown): 'denied' | 'no-microphone' {
  const name = (error as { name?: unknown } | null | undefined)?.name
  return name === 'NotAllowedError' || name === 'SecurityError' ? 'denied' : 'no-microphone'
}

export function dictationErrorText(problem: DictationProblem, detail?: string): string {
  switch (problem) {
    case 'credential':
      return 'Dictation failed: the transcription provider rejected the API key.'
    case 'quota':
      return "Dictation failed: the transcription provider's quota is used up. Try again later."
    case 'provider':
      return 'Dictation failed: the transcription provider did not answer properly. Try again.'
    case 'timeout':
      return 'Dictation took too long. Nothing was added — try again.'
    case 'unreachable':
      return 'Could not reach Factotum. Nothing was added — try again.'
    case 'too-large':
      return 'That recording is too long to transcribe. Try a shorter one.'
    case 'host':
      return 'Factotum could not process the recording on this host.'
    case 'off':
      return detail === undefined ? 'Dictation is off on this Factotum.' : `Dictation is off on this Factotum: ${detail}`
    case 'old':
      return 'Update Factotum to dictate.'
    case 'denied':
      return 'Microphone access is blocked. Allow it in the site settings to dictate.'
    case 'no-microphone':
      return 'No microphone here. Dictation needs one, and a secure (https) page.'
    case 'unsupported':
      return 'This browser cannot record audio in a format Factotum accepts.'
    case 'nothing-heard':
      return 'Nothing was heard, so nothing was sent.'
    case 'unknown':
      return detail === undefined ? 'Dictation failed.' : `Dictation failed: ${detail}`
  }
}
