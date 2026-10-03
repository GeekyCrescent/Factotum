/**
 * Dictation's ceilings, the audio it accepts, and how a transcript is cleaned (spec 2026-10-03, D2).
 *
 * THIS FOLDER IMPORTS NOTHING FROM THE REST OF THE MODULE — not the engine, not `../types.ts`, not
 * `../server.ts`. Dictation lives inside `sessions` because the composer does (ADR-0015), and the day
 * another module wants it, moving this folder out is the whole migration.
 *
 * Pure: no I/O, nothing from outside the folder.
 */

/** The hard stop of one recording. The screen reads it from `GET /dictation` and keeps no copy. */
export const DICTATION_MAX_SECONDS = 90

/** 90 s of opus at 24 kbps is ~290 kB (measured, A1); AAC from Safari runs bigger. Well within the kernel's 32 MiB. */
export const DICTATION_MAX_BYTES = 4 * 1024 * 1024

/** Only the call to the provider. Shorter than the screen's own wait, so the owner reads a reason, not a timeout. */
export const PROVIDER_TIMEOUT_MS = 20_000

/** Whisper drops the start of a longer prompt silently from ~550 characters (Jarvis D1); the API refuses past 896. */
export const MAX_PROMPT_CHARS = 500
export const MAX_TERMS = 30
export const MAX_TERM_CHARS = 60

export const DEFAULT_MODEL = 'whisper-large-v3-turbo'

/**
 * The container decides the extension in the upload, and the EXTENSION decides whether the provider takes
 * it: the same bytes named `.bin` come back 400 `unsupported_audio_format` (measured, A1). This list does
 * both jobs — it picks the name and it refuses what would be refused, before a request is paid for.
 */
export const AUDIO_TYPES: Readonly<Record<string, string>> = {
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
}

/**
 * What went wrong at the provider. It travels in the BODY (`dictation.failure`), never as `error.code`:
 * `ERROR_CODES` is a closed list owned by the core, and a new code would mean touching it (ADR-0015).
 */
export type ProviderFailure = 'credential' | 'quota' | 'failed'

export const NOT_CONFIGURED = 'dictation is not configured on this Factotum (modules.sessions.dictation)'

/** `audio/webm;codecs=opus` → `audio/webm`. Anything not in `AUDIO_TYPES` → `undefined`. */
export function baseType(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined
  const base = raw.split(';', 1)[0]?.trim().toLowerCase() ?? ''
  return Object.hasOwn(AUDIO_TYPES, base) ? base : undefined
}

/** Letters or digits in any script: a transcript without one is punctuation, and punctuation is nothing. */
const MEANINGFUL = /[\p{L}\p{N}]/u

/** Trimmed, and empty when nothing but punctuation and spaces is left (criterion 14). */
export function normalizeTranscript(raw: string): string {
  const trimmed = raw.trim()
  return MEANINGFUL.test(trimmed) ? trimmed : ''
}
