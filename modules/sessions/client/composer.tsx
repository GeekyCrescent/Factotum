/**
 * The composer: launching a session and replying to one, the same box (spec 2026-09-18, criteria
 * 18, 19). It grows with the text up to 40 % of the height.
 *
 * THE KEYS (2026-09-30): on a computer Enter sends and Shift+Enter breaks the line; on a phone
 * Enter breaks the line and the button sends, because a phone's Enter is where a person expects a
 * new line. Ctrl/Cmd+Enter sends everywhere. Never while an input method is composing a word.
 *
 * Under the text, one row: `+` (attaching files, not yet: disabled), the project, what to run, and
 * send. Above the box, three suggestions that do nothing yet, disabled until they get a use.
 *
 * A 409 is read off the body the error carries: `conflict` (the site is busy) and `freshness` (the
 * repo is not clean or not up to date) each get their own notice, and going over a stale repo is
 * the owner's call, exactly as it was before this spec.
 */

import type { ComponentChildren } from 'preact'
import { useState } from 'preact/hooks'
import type { Color, EngineSetupView } from '../types.ts'
import type { Api } from './contract.ts'
import { conflictOf, describe, freshnessOf, messageOf, type Conflict, type Freshness } from './errors.ts'
import { Icon } from './icon.tsx'
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
  const s = useSend(async (text, force) => {
    const result = await api.post<{ sessionId: string }>('sessions', { siteId, entryId, text, force })
    onLaunched(result.sessionId)
  })

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
        canSend={!s.busy && s.text.trim() !== '' && entryId !== ''}
        send={() => void s.go(false)}
        autoFocus
        tone={siteId === '' ? undefined : toneClass(siteId, site?.color)}
      >
        <label class="chip s-pick">
          <Icon name="folder-simple" size={16} />
          <select aria-label="Project" value={siteId} onChange={(e) => setSiteId((e.target as HTMLSelectElement).value)}>
            {sites.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name ?? s.id}
              </option>
            ))}
          </select>
          <Icon name="caret-down" size={12} />
        </label>
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
    </>
  )
}

export function ReplyComposer({
  api,
  sessionId,
  project,
  onSent,
  goTo,
}: {
  readonly api: Api
  readonly sessionId: string
  /** The conversation's project, shown as a label in the row: a reply cannot change it. */
  readonly project: { readonly id: string; readonly label: string; readonly color: Color | undefined } | undefined
  readonly onSent: () => void
  readonly goTo: (sessionId: string) => void
}) {
  const s = useSend(async (text, force) => {
    await api.post(`sessions/${sessionId}/reply`, { text, force })
    onSent()
  })
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
        canSend={!s.busy && s.text.trim() !== ''}
        send={() => void s.go(false)}
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
  canSend,
  send,
  autoFocus,
  tone,
  children,
}: {
  readonly text: string
  readonly setText: (text: string) => void
  readonly placeholder: string
  readonly label: string
  readonly canSend: boolean
  readonly send: () => void
  readonly autoFocus: boolean
  /** The project's colour class, where the screen around it does not already set one (launching). */
  readonly tone?: string | undefined
  readonly children?: ComponentChildren
}) {
  return (
    <div class="s-composer">
      <Suggestions />
      <form
        class={tone === undefined ? 'composer' : `composer ${tone}`}
        onSubmit={(event) => {
          event.preventDefault()
          if (canSend) send()
        }}
      >
        <textarea
          rows={2}
          value={text}
          placeholder={placeholder}
          aria-label={placeholder}
          autoFocus={autoFocus}
          onInput={(event) => setText((event.target as HTMLTextAreaElement).value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return
            const sends = event.metaKey || event.ctrlKey || window.matchMedia(FINE_POINTER).matches
            if (!sends) return
            event.preventDefault()
            if (canSend) send()
          }}
        />
        <button type="button" class="s-plus" aria-label="Attach files (coming soon)" title="Coming soon" disabled>
          <Icon name="plus" size={18} />
        </button>
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
