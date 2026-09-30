/**
 * What is attached to a message, before and after it is sent. PURE: no DOM, no fetch (spec
 * 2026-10-01, D10, D11).
 *
 * THE SENT TEXT IS THE ONLY RECORD. While the owner writes, attachments are chips above the box; on
 * sending, each ready one becomes a line `@<path>` at the end of the text. From then on everything —
 * the thumbnail in the log, what a delete removes — is read back from those lines.
 *
 * The ceiling is never a copy here: it comes from the daemon's `view().uploads.maxBytes`.
 */

/** What the browser hands over: a `File`, or anything shaped like one in a test. */
export interface FileLike {
  readonly name: string
  readonly size: number
}

export type Attachment =
  | { readonly key: string; readonly state: 'uploading'; readonly name: string; readonly bytes: number; readonly preview: string | undefined }
  | {
      readonly key: string
      readonly state: 'ready'
      readonly name: string
      readonly bytes: number
      readonly preview: string | undefined
      /** Absolute, on the daemon's disk. What goes into the text. */
      readonly path: string
      readonly image: boolean
    }
  | { readonly key: string; readonly state: 'failed'; readonly name: string; readonly bytes: number; readonly reason: string }

export const ATTACHMENTS_PER_MESSAGE = 5

/** `1.2 MB`, `640 KB`, `12 B`. For the chip and the refusal. */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, '')} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return `${bytes} B`
}

/**
 * Which of these files may be attached now: none past the fifth, none over the ceiling (criteria
 * 22, 23). `refused` is the one sentence the box shows, or `undefined` when all went in.
 */
export function admit<F extends FileLike>(
  current: readonly Attachment[],
  files: readonly F[],
  maxBytes: number,
): { readonly accepted: readonly F[]; readonly refused: string | undefined } {
  const accepted: F[] = []
  const reasons: string[] = []
  let room = ATTACHMENTS_PER_MESSAGE - current.length
  for (const file of files) {
    if (file.size > maxBytes) {
      reasons.push(`${file.name} is over the ${formatBytes(maxBytes)} limit.`)
      continue
    }
    if (room <= 0) {
      reasons.push(`At most ${ATTACHMENTS_PER_MESSAGE} files per message.`)
      break
    }
    accepted.push(file)
    room -= 1
  }
  return { accepted, refused: reasons.length === 0 ? undefined : reasons.join(' ') }
}

/** The text that is sent: the words, then one `@<path>` line per ready attachment. */
export function withRefs(text: string, attachments: readonly Attachment[]): string {
  const lines = attachments.flatMap((attachment) => (attachment.state === 'ready' ? [`@${attachment.path}`] : []))
  if (lines.length === 0) return text
  const words = text.trimEnd()
  return words.trim() === '' ? lines.join('\n') : `${words}\n\n${lines.join('\n')}`
}

/** Whether the box may send now (criterion 21). A failed chip does not block; one still uploading does. */
export function canSend(state: {
  readonly busy: boolean
  readonly text: string
  readonly attachments: readonly Attachment[]
  /** Launching also needs a catalog entry chosen. */
  readonly ready: boolean
}): boolean {
  if (state.busy || !state.ready) return false
  if (state.attachments.some((attachment) => attachment.state === 'uploading')) return false
  return state.text.trim() !== '' || state.attachments.some((attachment) => attachment.state === 'ready')
}

// ---------------------------------------------------------------------------
// Whether this host takes files (criterion 27)
// ---------------------------------------------------------------------------

export type UploadsState =
  | { readonly kind: 'on'; readonly maxBytes: number }
  | { readonly kind: 'off'; readonly reason: string }
  /** A daemon from before uploads: its `/setup` has no `uploads` at all. */
  | { readonly kind: 'old' }

/**
 * Read AS DATA, never trusted as a type: a daemon from before this spec sends no `uploads`, and the
 * status of a failed upload would not say so (it answers 400 or 413, not 404).
 */
export function uploadsOf(setup: unknown): UploadsState {
  const uploads = (setup as { uploads?: unknown } | null | undefined)?.uploads
  if (typeof uploads !== 'object' || uploads === null) return { kind: 'old' }
  const { maxBytes, off } = uploads as { maxBytes?: unknown; off?: unknown }
  if (typeof off === 'string') return { kind: 'off', reason: off }
  if (typeof maxBytes === 'number' && maxBytes > 0) return { kind: 'on', maxBytes }
  return { kind: 'old' }
}

/** What the `+` and a drop say when the host does not take files. */
export function unavailableText(state: UploadsState): string | undefined {
  if (state.kind === 'old') return 'Update Factotum to attach files.'
  if (state.kind === 'off') return `Attaching is off on this Factotum: ${state.reason}`
  return undefined
}

/**
 * One line for a failed upload. A status of 0 is a request that never got an answer — no network, the
 * daemon down, OR a connection the daemon cut while refusing a file too big — so it never claims to
 * know which (criterion 26).
 */
export function errorText(cause: unknown): string {
  const failure = cause as { status?: unknown; message?: unknown; body?: { uploads?: { off?: unknown } } } | null
  const status = typeof failure?.status === 'number' ? failure.status : 0
  if (status === 0 || status === 502 || status === 503 || status === 504) return 'Upload failed: could not reach Factotum.'
  if (status === 413) return 'That file is over the size limit.'
  const off = failure?.body?.uploads?.off
  if (status === 409 && typeof off === 'string') return `Attaching is off on this Factotum: ${off}`
  return typeof failure?.message === 'string' && failure.message !== '' ? failure.message : `Upload failed (${status}).`
}

// ---------------------------------------------------------------------------
// Reading the sent text back (criterion 29)
// ---------------------------------------------------------------------------

export type Piece =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'ref'; readonly uploadId: string; readonly name: string; readonly image: boolean }

/**
 * A reference is a WHOLE LINE `@<anything>/uploads/<uuidv7>/<name>`. The screen does not know the
 * daemon's root and does not need to: it only asks the module for `uploads/<id>/<name>`, and the
 * module checks both. Anything else stays text.
 */
const REF = /^@\S*\/uploads\/([0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/([A-Za-z0-9._-]+)$/

/** What a browser may paint, by name. A wrong guess falls to the file chip (`onError`, criterion 31). */
const RASTER = /\.(png|jpe?g|gif|webp)$/i

export function isImageName(name: string): boolean {
  return RASTER.test(name)
}

export function splitRefs(text: string): readonly Piece[] {
  const pieces: Piece[] = []
  let words: string[] = []
  const flush = () => {
    const joined = words.join('\n').trim()
    if (joined !== '') pieces.push({ kind: 'text', text: joined })
    words = []
  }
  for (const line of text.split('\n')) {
    const match = REF.exec(line.trim())
    if (match === null) {
      words.push(line)
      continue
    }
    flush()
    const [, uploadId, name] = match as unknown as [string, string, string]
    pieces.push({ kind: 'ref', uploadId, name, image: isImageName(name) })
  }
  flush()
  return pieces
}

/** Where the module serves an upload, relative to its prefix. */
export function uploadUrl(uploadId: string, name: string): string {
  return `/modules/sessions/uploads/${uploadId}/${encodeURIComponent(name)}`
}
