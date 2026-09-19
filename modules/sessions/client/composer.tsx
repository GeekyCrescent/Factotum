/**
 * The composer: launching a session and replying to one, the same box (spec 2026-09-18, criteria
 * 18, 19). It grows with the text up to 40 % of the height, and Ctrl/Cmd+Enter sends.
 *
 * A 409 is read off the body the error carries: `conflict` (the site is busy) and `freshness` (the
 * repo is not clean or not up to date) each get their own notice, and going over a stale repo is
 * the owner's call, exactly as it was before this spec.
 */

import type { ComponentChildren } from 'preact'
import { useState } from 'preact/hooks'
import type { EngineSetupView } from '../types.ts'
import type { Api } from './contract.ts'
import { conflictOf, describe, freshnessOf, messageOf, type Conflict, type Freshness } from './errors.ts'
import { Icon } from './icon.tsx'

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
}: {
  readonly api: Api
  readonly setup: EngineSetupView
  readonly onLaunched: (sessionId: string) => void
  readonly goTo: (sessionId: string) => void
}) {
  const usable = setup.catalog.filter((entry) => entry.disabledReason === undefined)
  const [siteId, setSiteId] = useState(setup.sites[0]?.id ?? '')
  const [entryId, setEntryId] = useState(usable[0]?.id ?? '')
  const s = useSend(async (text, force) => {
    const result = await api.post<{ sessionId: string }>('sessions', { siteId, entryId, text, force })
    onLaunched(result.sessionId)
  })

  if (setup.sites.length === 0) {
    return (
      <div class="notice">
        <div class="head">No sites</div>
        <p class="dim-2">
          Declare one under <code>modules.sessions.sites</code> in <code>~/.factotum/&lt;env&gt;/config.json</code> and
          restart. Nothing is allowed by being inside a folder: a site is allowed because you wrote it down.
        </p>
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
        placeholder="What should it do?"
        label="Launch"
        canSend={!s.busy && s.text.trim() !== '' && entryId !== ''}
        send={() => void s.go(false)}
        autoFocus
      >
        <label class="chip s-pick">
          <Icon name="folder-simple" size={16} />
          <select aria-label="Site" value={siteId} onChange={(e) => setSiteId((e.target as HTMLSelectElement).value)}>
            {setup.sites.map((site) => (
              <option key={site.id} value={site.id}>
                {site.id}
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
  siteId,
  onSent,
  goTo,
}: {
  readonly api: Api
  readonly sessionId: string
  readonly siteId: string | undefined
  readonly onSent: () => void
  readonly goTo: (sessionId: string) => void
}) {
  const s = useSend(async (text, force) => {
    await api.post(`sessions/${sessionId}/reply`, { text, force })
    onSent()
  })
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
        placeholder="Reply"
        label="Reply"
        canSend={!s.busy && s.text.trim() !== ''}
        send={() => void s.go(false)}
        autoFocus={false}
      >
        {siteId === undefined ? null : <span class="s-ctx mono">replying in {siteId}</span>}
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
  children,
}: {
  readonly text: string
  readonly setText: (text: string) => void
  readonly placeholder: string
  readonly label: string
  readonly canSend: boolean
  readonly send: () => void
  readonly autoFocus: boolean
  readonly children: ComponentChildren
}) {
  return (
    <form
      class="composer"
      onSubmit={(event) => {
        event.preventDefault()
        if (canSend) send()
      }}
    >
      <textarea
        rows={1}
        value={text}
        placeholder={placeholder}
        aria-label={placeholder}
        autoFocus={autoFocus}
        onInput={(event) => setText((event.target as HTMLTextAreaElement).value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && canSend) {
            event.preventDefault()
            send()
          }
        }}
      />
      <div class="row">
        {children}
        <button type="submit" class="send" aria-label={label} disabled={!canSend}>
          <Icon name="arrow-up" size={18} />
        </button>
      </div>
    </form>
  )
}

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
