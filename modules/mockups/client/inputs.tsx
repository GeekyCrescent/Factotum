/**
 * The inputs of a mockup (criteria 9–12): the list with its kind and the «real client data» mark, an
 * upload, a real sample, and a note written or dictated. Closed while a stage runs, with the reason.
 *
 * The file goes as its raw bytes to `POST mockups/:id/inputs?name=…` (`?private=1` for a real sample);
 * the kernel caps it at 50 MiB and answers 413 itself.
 */

import { useRef, useState } from 'preact/hooks'
import { DictateButton, DictationNotice, useComposerDictation } from '../../shared/dictation/dictate.tsx'
import type { Api as DictationApi } from '../../shared/dictation/contract.ts'
import type { Mockup } from '../types.ts'
import type { ModuleApi } from './contract.ts'
import { messageOf, statusOf } from './launch.ts'
import { inputsBlocked } from './model.ts'

const MIB = 1024 * 1024

function sizeOf(bytes: number, kind: string): string {
  if (kind === 'note') return 'note'
  if (bytes >= MIB) return `${(bytes / MIB).toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

export function Inputs({ api, dictationApi, mockup, onChanged }: { readonly api: ModuleApi; readonly dictationApi: DictationApi | undefined; readonly mockup: Mockup; readonly onChanged: (m: Mockup) => void }) {
  const blocked = inputsBlocked(mockup)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [noting, setNoting] = useState(false)
  const file = useRef<HTMLInputElement>(null)
  const realFile = useRef<HTMLInputElement>(null)
  const base = `mockups/${encodeURIComponent(mockup.id)}`

  const upload = async (picked: File | undefined, isPrivate: boolean): Promise<void> => {
    if (picked === undefined) return
    setBusy(true)
    setError(undefined)
    try {
      onChanged(await api.upload<Mockup>(`${base}/inputs`, picked, isPrivate ? { name: picked.name, private: '1' } : { name: picked.name }))
    } catch (cause) {
      setError(statusOf(cause) === 413 ? `${picked.name} is over 50 MB.` : messageOf(cause))
    } finally {
      setBusy(false)
      if (file.current !== null) file.current.value = ''
      if (realFile.current !== null) realFile.current.value = ''
    }
  }

  return (
    <section class="mk-inputs" aria-labelledby="mk-inputs-h">
      <h3 id="mk-inputs-h" class="mk-h3">
        Inputs
      </h3>
      {mockup.inputs.length === 0 ? <p class="mk-empty">Nothing yet: the RFP, the meeting notes, a few lines. The brief reads all of it.</p> : null}
      <ul class="mk-in-list">
        {mockup.inputs.map((input) => (
          <li key={`${input.private ? 'p' : ''}${input.name}`} class="mk-in-row">
            <span class="mk-in-kind">{input.kind}</span>
            <span class="mk-ellipsis">{input.name}</span>
            {input.private ? <span class="chip mk-private">real client data</span> : null}
            <span class="mk-in-size">{sizeOf(input.bytes, input.kind)}</span>
          </li>
        ))}
      </ul>
      {blocked !== undefined ? (
        <p class="mk-cap">{blocked}.</p>
      ) : (
        <>
          <div class="mk-row mk-wrap">
            <button type="button" class="btn sm" disabled={busy} onClick={() => file.current?.click()}>
              Upload
            </button>
            <button type="button" class="btn sm" disabled={busy} onClick={() => realFile.current?.click()}>
              Real client data
            </button>
            <button type="button" class="btn sm quiet" disabled={busy} onClick={() => setNoting(true)}>
              Note
            </button>
            <input ref={file} type="file" hidden onChange={(e) => void upload((e.currentTarget as HTMLInputElement).files?.[0], false)} />
            <input ref={realFile} type="file" hidden onChange={(e) => void upload((e.currentTarget as HTMLInputElement).files?.[0], true)} />
          </div>
          {noting ? <NoteBox api={api} dictationApi={dictationApi} base={base} onDone={(m) => { setNoting(false); if (m !== undefined) onChanged(m) }} /> : null}
        </>
      )}
      {busy ? <p class="mk-cap">Uploading…</p> : null}
      {error === undefined ? null : <p class="mk-notice mk-err">{error}</p>}
    </section>
  )
}

function NoteBox({ api, dictationApi, base, onDone }: { readonly api: ModuleApi; readonly dictationApi: DictationApi | undefined; readonly base: string; readonly onDone: (m: Mockup | undefined) => void }) {
  const [text, setText] = useState('')
  const [error, setError] = useState<string | undefined>(undefined)
  const [saving, setSaving] = useState(false)
  const box = useRef<HTMLTextAreaElement>(null)
  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      onDone(await api.post<Mockup>(`${base}/notes`, { text }))
    } catch (cause) {
      setError(messageOf(cause))
      setSaving(false)
    }
  }
  return (
    <div class="mk-note">
      <label class="mk-cap" for="mk-note">
        A note: the meeting, bullets, what the client said
      </label>
      <div class="mk-redo-field">
        <textarea id="mk-note" ref={box} value={text} onInput={(e) => setText((e.currentTarget as HTMLTextAreaElement).value)} />
        {dictationApi === undefined ? null : <NoteDictation api={dictationApi} text={text} setText={setText} box={box} />}
      </div>
      <div class="mk-row">
        <button type="button" class="btn sm quiet" onClick={() => onDone(undefined)}>
          Cancel
        </button>
        <button type="button" class="btn sm primary" disabled={saving || text.trim() === ''} onClick={() => void save()}>
          Save note
        </button>
      </div>
      {error === undefined ? null : <p class="mk-notice mk-err">{error}</p>}
    </div>
  )
}

/** Its own component: the dictation hook needs the api, and a host without sessions has none. */
export function NoteDictation({ api, text, setText, box }: { readonly api: DictationApi; readonly text: string; readonly setText: (t: string) => void; readonly box: { readonly current: HTMLTextAreaElement | null } }) {
  const dictation = useComposerDictation(api, text, setText, box as never)
  return (
    <div class="mk-dictate">
      <DictateButton dictation={dictation} />
      <DictationNotice dictation={dictation} />
    </div>
  )
}
