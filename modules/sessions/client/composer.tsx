/**
 * The composer: launching a session and replying to one, the same box (spec 2026-09-18, criteria
 * 18, 19). It grows with the text up to 40 % of the height.
 *
 * THE KEYS (2026-09-30): on a computer Enter sends and Shift+Enter breaks the line; on a phone
 * Enter breaks the line and the button sends, because a phone's Enter is where a person expects a
 * new line. Ctrl/Cmd+Enter sends everywhere. Never while an input method is composing a word.
 *
 * Under the text, one row: `+` (attaching files), the project (a sheet, `project-pick.tsx`), what to
 * run, and send. Above the box,
 * three suggestions that do nothing yet, disabled until they get a use.
 *
 * ATTACHING (spec 2026-10-01, D10): chips above the box, `+` in the row, and a file dropped on the box
 * or pasted into the text. On sending, each ready file becomes a line `@<path>` after the words — the
 * sent text is the only record — and the chips go only when the send went through.
 *
 * A 409 is read off the body the error carries: `conflict` (the site is busy) and `freshness` (the
 * repo is not clean or not up to date) each get their own notice, and going over a stale repo is
 * the owner's call, exactly as it was before this spec.
 */

import type { ComponentChildren } from 'preact'
import { useCallback, useState } from 'preact/hooks'
import type { Color, EngineSetupView } from '../types.ts'
import { AttachButton, Chips, dropsFolder, useAttachments, type AttachControls } from './attach.tsx'
import { canSend, uploadsOf, withRefs } from './attachments.ts'
import type { Api } from './contract.ts'
import { DictateButton, DictationNotice, useComposerDictation, type DictationControls } from './dictate.tsx'
import { conflictOf, describe, freshnessOf, messageOf, type Conflict, type Freshness } from './errors.ts'
import { Icon } from './icon.tsx'
import { FilePicker, usePicker, type PickerControls } from './picker.tsx'
import { ProjectButton, ProjectSheet, useArrangement } from './project-pick.tsx'
import { filesOf } from './refs.ts'
import { toneClass } from './tone.ts'

/** The same question whether it starts a session or carries one on. */
const ASK_WHAT = 'What do you want to do in this project?'

type Problem =
  | { readonly kind: 'conflict'; readonly conflict: Conflict }
  | { readonly kind: 'stale'; readonly freshness: Freshness }
  | { readonly kind: 'error'; readonly message: string }

function problemOf(cause: unknown): Problem {
  const conflict = conflictOf(cause)
  if (conflict !== undefined) return { kind: 'conflict', conflict }
  const freshness = freshnessOf(cause)
  if (freshness !== undefined) return { kind: 'stale', freshness }
  return { kind: 'error', message: messageOf(cause) }
}

/** Sends, and turns a failure into the notice it deserves. The text is kept until it went through. */
function useSend(send: (text: string, force: boolean) => Promise<void>) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<Problem | undefined>(undefined)
  const go = async (force: boolean) => {
    setBusy(true)
    setProblem(undefined)
    try {
      await send(text, force)
      setText('')
    } catch (cause: unknown) {
      setProblem(problemOf(cause))
    } finally {
      setBusy(false)
    }
  }
  return {
    text,
    setText,
    busy,
    problem,
    clear: () => setProblem(undefined),
    fail: (message: string) => setProblem({ kind: 'error', message }),
    go,
  }
}

export function LaunchComposer({
  api,
  setup,
  onLaunched,
  goTo,
  onManage,
}: {
  readonly api: Api
  readonly setup: EngineSetupView
  readonly onLaunched: (sessionId: string) => void
  readonly goTo: (sessionId: string) => void
  /** To the projects screen, where one is added (spec 2026-09-29, D10). */
  readonly onManage: () => void
}) {
  const usable = setup.catalog.filter((entry) => entry.disabledReason === undefined)
  // A project whose folder is missing launches nothing (criterion 23): it is not offered.
  const sites = setup.sites.filter((site) => site.status === 'ok')
  const [siteId, setSiteId] = useState(sites[0]?.id ?? '')
  const site = sites.find((s) => s.id === siteId)
  const [entryId, setEntryId] = useState(usable[0]?.id ?? '')
  const attach = useAttachments(api, uploadsOf(setup))
  const s = useSend(async (text, force) => {
    const sent = attach.items.filter((item) => item.state === 'ready')
    const result = await api.post<{ sessionId: string }>('sessions', { siteId, entryId, text: withRefs(text, sent), force })
    attach.clear(sent.map((item) => item.key))
    dictation.clear()
    onLaunched(result.sessionId)
  })
  // `@` lists the project chosen in the select; changing it re-reads the token (criterion 24).
  const picker = usePicker({ api, site, capability: filesOf(setup), text: s.text, setText: s.setText })
  // Before the early return below: a hook is called on every render or on none.
  const dictation = useComposerDictation(api, s.text, s.setText, picker.textarea)
  // The project's sheet, with the drawer's categories; outside the box's form, so none of its styles reach it.
  const arrangement = useArrangement(api)
  const [choosing, setChoosing] = useState(false)
  const stopChoosing = useCallback(() => setChoosing(false), [])

  if (sites.length === 0) {
    return (
      <div class="notice">
        <div class="head">{setup.sites.length === 0 ? 'No projects yet' : 'No project can launch'}</div>
        <p class="dim-2">
          {setup.sites.length === 0
            ? 'Add one in Projects. Nothing is allowed by being inside a folder: a project is allowed because you approved it.'
            : 'The folders of your projects are missing. Put them back, or look at them in Projects.'}
        </p>
        <div class="acts">
          <button type="button" class="btn" onClick={onManage}>
            Projects
          </button>
        </div>
      </div>
    )
  }

  const disabled = setup.catalog.filter((entry) => entry.disabledReason !== undefined)
  return (
    <>
      {disabled.length > 0 ? (
        <div class="notice">
          {disabled.map((entry) => (
            <p key={entry.id} class="dim-2">
              <strong>{entry.label}</strong> is disabled: <code>{entry.disabledReason}</code>
            </p>
          ))}
        </div>
      ) : null}
      <Problems
        problem={s.problem}
        busy={s.busy}
        goTo={goTo}
        conflictText="That site already has a live session."
        staleTitle="That site is not clean or not up to date"
        anyway="Launch anyway"
        onAnyway={() => void s.go(true)}
        onKeep={s.clear}
        onCancelOther={(id) =>
          void api
            .post(`sessions/${id}/cancel`)
            .then(s.clear)
            .catch((cause: unknown) => s.fail(messageOf(cause)))
        }
      />
      <Box
        text={s.text}
        setText={s.setText}
        placeholder={ASK_WHAT}
        label="Launch"
        attach={attach}
        canSend={canSend({ busy: s.busy, text: s.text, attachments: attach.items, ready: entryId !== '' }) && !dictation.busy}
        send={() => void s.go(false)}
        picker={picker}
        dictation={dictation}
        autoFocus
        tone={siteId === '' ? undefined : toneClass(siteId, site?.color)}
      >
        <ProjectButton
          site={site}
          onOpen={() => {
            arrangement.load()
            setChoosing(true)
          }}
        />
        <label class="chip s-pick">
          <select aria-label="What to run" value={entryId} onChange={(e) => setEntryId((e.target as HTMLSelectElement).value)}>
            {usable.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.label}
              </option>
            ))}
          </select>
          <Icon name="caret-down" size={12} />
        </label>
      </Box>
      {choosing ? (
        <ProjectSheet
          sites={sites}
          value={siteId}
          loaded={arrangement.loaded}
          onClose={stopChoosing}
          onPick={(id) => {
            setSiteId(id)
            setChoosing(false)
          }}
        />
      ) : null}
    </>
  )
}

export function ReplyComposer({
  api,
  setup,
  sessionId,
  project,
  onSent,
  goTo,
}: {
  readonly api: Api
  /** Only for whether this host takes files, and up to how big (spec 2026-10-01, D10). */
  readonly setup: EngineSetupView
  readonly sessionId: string
  /** The conversation's project, shown as a label in the row: a reply cannot change it. */
  readonly project: { readonly id: string; readonly label: string; readonly color: Color | undefined } | undefined
  readonly onSent: () => void
  readonly goTo: (sessionId: string) => void
}) {
  const attach = useAttachments(api, uploadsOf(setup))
  const s = useSend(async (text) => {
    const sent = attach.items.filter((item) => item.state === 'ready')
    await api.post(`sessions/${sessionId}/reply`, { text: withRefs(text, sent) })
    attach.clear(sent.map((item) => item.key))
    dictation.clear()
    onSent()
  })
  const site = project === undefined ? undefined : setup.sites.find((candidate) => candidate.id === project.id)
  const picker = usePicker({ api, site, capability: filesOf(setup), text: s.text, setText: s.setText })
  const dictation = useComposerDictation(api, s.text, s.setText, picker.textarea)
  const tone = project === undefined ? undefined : toneClass(project.id, project.color)
  return (
    <>
      <Problems
        problem={s.problem}
        busy={s.busy}
        goTo={goTo}
        conflictText="That site is busy with another session. Cancel it first."
        staleTitle="The site changed since the last turn"
        anyway="Reply anyway"
        onAnyway={() => void s.go(true)}
        onKeep={s.clear}
        onCancelOther={undefined}
      />
      <Box
        text={s.text}
        setText={s.setText}
        placeholder={ASK_WHAT}
        label="Reply"
        attach={attach}
        canSend={canSend({ busy: s.busy, text: s.text, attachments: attach.items, ready: true }) && !dictation.busy}
        send={() => void s.go(false)}
        picker={picker}
        dictation={dictation}
        autoFocus={false}
        tone={tone}
      >
        {project === undefined ? null : (
          <span class="chip s-pick s-static">
            <Icon name="folder-simple" size={16} />
            {project.label}
          </span>
        )}
      </Box>
    </>
  )
}

function Box({
  text,
  setText,
  placeholder,
  label,
  attach,
  canSend,
  send,
  picker,
  dictation,
  autoFocus,
  tone,
  children,
}: {
  readonly text: string
  readonly setText: (text: string) => void
  readonly placeholder: string
  readonly label: string
  readonly attach: AttachControls
  readonly canSend: boolean
  readonly send: () => void
  /** The `@` list (spec 2026-10-01-referencias-y-tab, D9): it is asked about every key first. */
  readonly picker: PickerControls
  /** Dictation (spec 2026-10-03): the mic beside `+`, and its notice above the box. */
  readonly dictation: DictationControls
  readonly autoFocus: boolean
  /** The project's colour class, where the screen around it does not already set one (launching). */
  readonly tone?: string | undefined
  readonly children?: ComponentChildren
}) {
  const [dropping, setDropping] = useState(false)
  const classes = ['composer', tone, dropping ? 's-dropping' : undefined].filter((c) => c !== undefined).join(' ')
  return (
    <div class="s-composer">
      <Suggestions />
      <Chips attach={attach} />
      <DictationNotice dictation={dictation} />
      <FilePicker picker={picker} />
      <form
        class={classes}
        onSubmit={(event) => {
          event.preventDefault()
          if (canSend) send()
        }}
        // A file from Finder dropped ON THE BOX (the brief: only here, not the whole window).
        onDragOver={(event) => {
          if (!event.dataTransfer?.types.includes('Files')) return
          event.preventDefault()
          setDropping(true)
        }}
        onDragLeave={(event) => {
          if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
          setDropping(false)
        }}
        onDrop={(event) => {
          if (event.dataTransfer === null || !event.dataTransfer.types.includes('Files')) return
          event.preventDefault()
          setDropping(false)
          if (dropsFolder(event.dataTransfer)) return attach.refuse('Folders cannot be attached. Drop the files inside it instead.')
          attach.add(Array.from(event.dataTransfer.files))
        }}
      >
        <textarea
          ref={picker.textarea}
          rows={2}
          value={text}
          placeholder={placeholder}
          aria-label={placeholder}
          autoFocus={autoFocus}
          aria-autocomplete="list"
          aria-controls={picker.view.kind === 'rows' ? picker.listId : undefined}
          aria-expanded={picker.view.kind === 'rows'}
          aria-activedescendant={picker.view.kind === 'rows' && picker.view.selected >= 0 ? picker.optionId(picker.view.selected) : undefined}
          onInput={(event) => {
            setText((event.target as HTMLTextAreaElement).value)
            picker.sync()
          }}
          onClick={picker.sync}
          onKeyUp={picker.sync}
          onFocus={picker.sync}
          // A screenshot on the clipboard is attached; text is pasted as it always was (criterion 15).
          // A copy from a spreadsheet carries BOTH its text and a picture of it: that is text.
          onPaste={(event) => {
            const files = Array.from(event.clipboardData?.files ?? [])
            if (files.length === 0 || (event.clipboardData?.getData('text/plain') ?? '') !== '') return
            event.preventDefault()
            attach.add(files)
          }}
          onKeyDown={(event) => {
            // The `@` list first: with it open, Tab, the arrows, Enter and Esc are its (criteria 20, 21).
            if (picker.onKey(event)) return
            if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return
            const sends = event.metaKey || event.ctrlKey || window.matchMedia(FINE_POINTER).matches
            if (!sends) return
            event.preventDefault()
            if (canSend) send()
          }}
        />
        <AttachButton attach={attach} />
        <DictateButton dictation={dictation} />
        <span class="s-sep" aria-hidden="true" />
        {children}
        <button type="submit" class="send" aria-label={label} disabled={!canSend}>
          <Icon name="arrow-up" size={18} />
        </button>
      </form>
      <p class="s-keys">Enter to send · Shift + Enter for a new line</p>
    </div>
  )
}

/** A mouse or a trackpad: Enter sends. A finger: Enter breaks the line. */
const FINE_POINTER = '(pointer: fine)'

/**
 * Three things to start from, above the box. None of them works yet, so all three are disabled and
 * say so; they get a use later (2026-09-30).
 */
function Suggestions() {
  return (
    <div class="s-suggest" role="group" aria-label="Suggestions (coming soon)">
      {SUGGESTIONS.map((suggestion) => (
        <button type="button" key={suggestion.label} class="s-suggest-btn" disabled title="Coming soon">
          <Icon name={suggestion.icon} size={16} />
          {suggestion.label}
        </button>
      ))}
    </div>
  )
}

const SUGGESTIONS: readonly { readonly label: string; readonly icon: 'folder-open' | 'code' | 'lightning' }[] = [
  { label: 'Explore the project', icon: 'folder-open' },
  { label: 'Review code', icon: 'code' },
  { label: 'Implement a change', icon: 'lightning' },
]

function Problems({
  problem,
  busy,
  goTo,
  conflictText,
  staleTitle,
  anyway,
  onAnyway,
  onKeep,
  onCancelOther,
}: {
  readonly problem: Problem | undefined
  readonly busy: boolean
  readonly goTo: (sessionId: string) => void
  readonly conflictText: string
  readonly staleTitle: string
  readonly anyway: string
  readonly onAnyway: () => void
  readonly onKeep: () => void
  readonly onCancelOther: ((sessionId: string) => void) | undefined
}) {
  if (problem === undefined) return null
  if (problem.kind === 'error') {
    return (
      <div class="notice err" role="alert">
        <div class="head">
          <Icon name="warning" size={16} />
          {problem.message}
        </div>
      </div>
    )
  }
  if (problem.kind === 'conflict') {
    const other = problem.conflict.sessionId
    return (
      <div class="notice ask" role="alert">
        <div class="head">
          <Icon name="warning" size={16} />
          {conflictText}
        </div>
        <div class="acts">
          <button type="button" class="btn" onClick={() => goTo(other)}>
            Go to it
          </button>
          {onCancelOther === undefined ? null : (
            <button type="button" class="btn quiet" onClick={() => onCancelOther(other)}>
              Cancel it
            </button>
          )}
        </div>
      </div>
    )
  }
  return (
    <div class="notice ask" role="alert">
      <div class="head">
        <Icon name="warning" size={16} />
        {staleTitle}
      </div>
      <p class="mono s-detail">{describe(problem.freshness)}</p>
      <div class="acts">
        <button type="button" class="btn" disabled={busy} onClick={onAnyway}>
          {anyway}
        </button>
        <button type="button" class="btn quiet" onClick={onKeep}>
          Keep editing
        </button>
      </div>
    </div>
  )
}
