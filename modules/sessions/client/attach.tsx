/**
 * Attaching files in the composer (spec 2026-10-01, D10): the state, the chips above the box, and the
 * `+`. Dropping and pasting are wired in `composer.tsx`, on the box itself.
 *
 * A FILE IS UPLOADED THE MOMENT IT IS ATTACHED, not when the message is sent: the chip gets its
 * thumbnail at once and sending never waits on bytes. The price is a file that is attached and then
 * never sent — an orphan, left on the daemon's disk on purpose (out of scope).
 *
 * `+` ON A COMPUTER opens the file picker. ON A PHONE it opens two choices, because on Android a
 * `capture` input REPLACES the picker instead of joining it (the predecessor's D9): one input for
 * photos and files, one for the camera.
 */

import { useEffect, useRef, useState } from 'preact/hooks'
import type { Api } from './contract.ts'
import {
  admit,
  errorText,
  formatBytes,
  isImageName,
  unavailableText,
  type Attachment,
  type UploadsState,
} from './attachments.ts'
import { Icon } from './icon.tsx'

/** What `POST uploads` answers when it keeps a file. */
interface UploadReply {
  readonly uploadId: string
  readonly name: string
  readonly path: string
  readonly bytes: number
  readonly image: boolean
}

export interface AttachControls {
  readonly items: readonly Attachment[]
  /** One sentence the box shows: a refusal, a folder dropped, a host that does not take files. */
  readonly notice: string | undefined
  readonly uploads: UploadsState
  readonly add: (files: readonly File[]) => void
  readonly refuse: (message: string) => void
  readonly remove: (key: string) => void
  readonly retry: (key: string) => void
  /**
   * After a send went through: THE CHIPS THAT WERE SENT go, with their previews. Only those — a file
   * dropped while the message was on its way was not in it, and must stay to go with the next one.
   */
  readonly clear: (sent: readonly string[]) => void
}

let counter = 0
const nextKey = (): string => `a${(counter += 1)}`

export function useAttachments(api: Api, uploads: UploadsState): AttachControls {
  const [items, setItems] = useState<readonly Attachment[]>([])
  const [notice, setNotice] = useState<string | undefined>(undefined)
  const current = useRef<readonly Attachment[]>(items)
  current.current = items
  // The File behind each chip, so a failed one can be retried without picking it again.
  const files = useRef(new Map<string, File>())

  // Previews are object URLs: they hold the whole file in memory until they are revoked.
  useEffect(
    () => () => {
      for (const item of current.current) if (item.state !== 'failed' && item.preview !== undefined) URL.revokeObjectURL(item.preview)
    },
    [],
  )

  const patch = (key: string, next: (item: Attachment) => Attachment) =>
    setItems((list) => list.map((item) => (item.key === key ? next(item) : item)))

  const send = (key: string, file: File, preview: string | undefined) => {
    void api.upload<UploadReply>('uploads', file, { name: file.name === '' ? 'pasted.png' : file.name }).then(
      (reply) =>
        patch(key, () => ({ key, state: 'ready', name: reply.name, bytes: reply.bytes, preview, path: reply.path, image: reply.image })),
      (cause: unknown) => {
        // A failed chip keeps no preview, so its URL is let go here — or it would hold the whole file
        // in memory until the tab closes. A retry makes a new one.
        if (preview !== undefined) URL.revokeObjectURL(preview)
        patch(key, () => ({ key, state: 'failed', name: file.name, bytes: file.size, reason: errorText(cause) }))
      },
    )
  }

  const revoke = (item: Attachment | undefined) => {
    if (item !== undefined && item.state !== 'failed' && item.preview !== undefined) URL.revokeObjectURL(item.preview)
  }

  return {
    items,
    notice,
    uploads,
    add: (list) => {
      const unavailable = unavailableText(uploads)
      if (unavailable !== undefined || uploads.kind !== 'on') {
        setNotice(unavailable)
        return
      }
      const { accepted, refused } = admit(current.current, list, uploads.maxBytes)
      setNotice(refused)
      const added: Attachment[] = []
      for (const file of accepted) {
        const key = nextKey()
        const preview = file.type.startsWith('image/') || isImageName(file.name) ? URL.createObjectURL(file) : undefined
        files.current.set(key, file)
        added.push({ key, state: 'uploading', name: file.name === '' ? 'pasted.png' : file.name, bytes: file.size, preview })
        send(key, file, preview)
      }
      // Counted into `current` at once, so a second drop in the same tick still sees these.
      current.current = [...current.current, ...added]
      setItems((list) => [...list, ...added])
    },
    refuse: (message) => setNotice(message),
    remove: (key) => {
      revoke(current.current.find((item) => item.key === key))
      files.current.delete(key)
      setItems((list) => list.filter((item) => item.key !== key))
    },
    retry: (key) => {
      const file = files.current.get(key)
      // Only a chip that is still failed: two taps in one tick must not upload it twice.
      if (file === undefined || current.current.find((item) => item.key === key)?.state !== 'failed') return
      const pending: Attachment = { key, state: 'uploading', name: file.name, bytes: file.size, preview: undefined }
      current.current = current.current.map((item) => (item.key === key ? pending : item))
      const preview = file.type.startsWith('image/') || isImageName(file.name) ? URL.createObjectURL(file) : undefined
      patch(key, () => ({ key, state: 'uploading', name: file.name, bytes: file.size, preview }))
      send(key, file, preview)
    },
    clear: (sent) => {
      const gone = new Set(sent)
      for (const item of current.current) if (gone.has(item.key)) revoke(item)
      for (const key of gone) files.current.delete(key)
      current.current = current.current.filter((item) => !gone.has(item.key))
      setNotice(undefined)
      setItems((list) => list.filter((item) => !gone.has(item.key)))
    },
  }
}

/** The chips above the box: a thumbnail or a file glyph, the name, the size or what went wrong. */
export function Chips({ attach }: { readonly attach: AttachControls }) {
  if (attach.items.length === 0 && attach.notice === undefined) return null
  return (
    <div class="s-attached">
      {attach.notice === undefined ? null : (
        <p class="s-attach-notice" role="status">
          <Icon name="warning" size={14} />
          {attach.notice}
        </p>
      )}
      {attach.items.length === 0 ? null : (
        <ul class="s-chips" aria-label="Attached files">
          {attach.items.map((item) => (
            <li key={item.key} class={`s-chip s-chip-${item.state}`}>
              {item.state !== 'failed' && item.preview !== undefined ? (
                <img class="s-chip-thumb" src={item.preview} alt="" />
              ) : (
                <span class="s-chip-glyph" aria-hidden="true">
                  <Icon name={item.state === 'failed' ? 'warning' : 'file-text'} size={18} />
                </span>
              )}
              <span class="s-chip-text">
                <span class="s-chip-name">{item.name}</span>
                <span class="s-chip-meta">
                  {item.state === 'uploading' ? 'Uploading…' : item.state === 'failed' ? item.reason : formatBytes(item.bytes)}
                </span>
              </span>
              {item.state === 'failed' ? (
                <button type="button" class="s-chip-retry" onClick={() => attach.retry(item.key)}>
                  Retry
                </button>
              ) : null}
              <button type="button" class="s-chip-x" aria-label={`Remove ${item.name}`} onClick={() => attach.remove(item.key)}>
                <Icon name="x-circle" size={16} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** A mouse or a trackpad: the picker straight away. A finger: the two choices. */
const FINE_POINTER = '(pointer: fine)'

/** Every file of an input, and the input emptied so the same file can be picked again. */
function takeFiles(input: HTMLInputElement): File[] {
  const list = Array.from(input.files ?? [])
  input.value = ''
  return list
}

export function AttachButton({ attach }: { readonly attach: AttachControls }) {
  const files = useRef<HTMLInputElement>(null)
  const camera = useRef<HTMLInputElement>(null)
  const [open, setOpen] = useState(false)
  const unavailable = unavailableText(attach.uploads)

  const pick = () => {
    // Not `disabled` when the host does not take files: a disabled button says nothing on a phone,
    // and this way a tap explains why (criterion 27).
    if (unavailable !== undefined) return attach.refuse(unavailable)
    if (window.matchMedia(FINE_POINTER).matches) return files.current?.click()
    setOpen((was) => !was)
  }

  return (
    <span class="s-attach">
      <button
        type="button"
        class={unavailable === undefined ? 's-plus' : 's-plus s-plus-off'}
        aria-label="Attach files"
        aria-haspopup="menu"
        aria-expanded={open}
        title={unavailable ?? 'Attach files'}
        onClick={pick}
      >
        <Icon name="plus" size={18} />
      </button>
      <input ref={files} type="file" multiple hidden onChange={(event) => attach.add(takeFiles(event.currentTarget))} />
      <input
        ref={camera}
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        onChange={(event) => attach.add(takeFiles(event.currentTarget))}
      />
      {open ? (
        <span class="s-attach-menu" role="menu">
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false)
              files.current?.click()
            }}
          >
            Photos &amp; files
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false)
              camera.current?.click()
            }}
          >
            Camera
          </button>
        </span>
      ) : null}
    </span>
  )
}

/** Whether a drop carries a folder. Only Chromium and Safari say; elsewhere a folder arrives empty. */
export function dropsFolder(transfer: DataTransfer): boolean {
  return Array.from(transfer.items).some((item) => item.webkitGetAsEntry?.()?.isDirectory === true)
}
