/**
 * One digest, and the "Check mail" button (spec 2026-10-05, D9).
 *
 * WITHOUT AN `id` it is the latest digest, and the button: while a run goes on the button is
 * disabled and the progress is polled every two seconds; when the run ends, the new digest is
 * fetched and drawn without a reload (criterion 18). Opening the screen with a run already going —
 * the owner left and came back — does the same, because the first `GET status` says so (criterion 17).
 *
 * WITH AN `id` it is a past digest from the history, read-only.
 *
 * THE SECTIONS FOLD, each with its own colour (to do in red, then orange, teal and pink: the project
 * hues the tokens keep apart from err / ok / ask). To do opens; the rest start folded.
 *
 * GLYPHS: four, in `icon.tsx`. Copy and Open in Gmail are icon buttons with their own labels; D9's
 * "text only" was relaxed for them after the screen was tried on the phone (docs/inbox.md §7).
 */

import type { ComponentChildren } from 'preact'
import { useCallback, useEffect, useRef, useState } from 'preact/hooks'
import type { AccountStatus, Digest, DigestEntry, InboxStatus } from '../types.ts'
import type { ViewProps } from './contract.ts'
import { Icon } from './icon.tsx'
import { dollars, dueText, metaLine, priorityOf, progressText, sectionsOf, seconds, splitFrom, tokens, type SenderGroup } from './model.ts'

const POLL_MS = 2_000
/** How long the copy button shows how it went before it is a copy button again. */
const COPIED_MS = 2_000
/** The only links drawn: the ones the daemon builds. A tampered file cannot make one `javascript:`. */
const GMAIL = 'https://mail.google.com/'

export function DigestView({ view, id }: { readonly view: ViewProps; readonly id?: string }) {
  const { api, navigate } = view
  const [status, setStatus] = useState<InboxStatus | undefined>(undefined)
  /** `null`: there is none yet (404). `undefined`: not loaded. */
  const [digest, setDigest] = useState<Digest | null | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [pressing, setPressing] = useState(false)
  /** Bumped by a failed poll, so the poll re-arms instead of stopping with the screen stuck on "running". */
  const [retry, setRetry] = useState(0)
  /** The id on screen NOW: a response for another one, arriving late, is dropped. */
  const shown = useRef(id)
  shown.current = id

  const loadStatus = useCallback(async (): Promise<InboxStatus> => {
    const next = await api.get<InboxStatus>('status')
    setStatus(next)
    return next
  }, [api])

  const loadDigest = useCallback(async (): Promise<void> => {
    try {
      const next = await api.get<Digest>(id === undefined ? 'digests/latest' : `digests/${encodeURIComponent(id)}`)
      if (shown.current !== id) return
      setDigest(next)
      setError(undefined)
    } catch (cause) {
      if (shown.current !== id) return
      if (statusOf(cause) === 404) setDigest(null)
      else setError(messageOf(cause))
    }
  }, [api, id])

  useEffect(() => {
    setDigest(undefined)
    void loadStatus().catch((cause: unknown) => setError(messageOf(cause)))
    void loadDigest()
  }, [loadStatus, loadDigest])

  // THE POLL: re-armed by every new status while a run goes on, and gone when it ends.
  useEffect(() => {
    if (status?.running !== true) return
    let live = true
    const timer = setTimeout(() => {
      void loadStatus()
        .then(async (next) => {
          if (live && !next.running && id === undefined) await loadDigest()
        })
        .catch((cause: unknown) => {
          if (!live) return
          setError(messageOf(cause))
          setRetry((count) => count + 1)
        })
    }, POLL_MS)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [status, retry, loadStatus, loadDigest, id])

  const checkMail = async (): Promise<void> => {
    setPressing(true)
    try {
      await api.post('run')
      setError(undefined)
    } catch (cause) {
      // 409: one is already going — the status below shows it, which is all the owner needs.
      if (statusOf(cause) !== 409) setError(messageOf(cause))
    } finally {
      try {
        // A run that ended before this first look — a password file that is wrong fails at once — arms
        // no poll: its digest is fetched here, or the screen keeps showing the previous one.
        const next = await loadStatus()
        if (!next.running) await loadDigest()
      } catch (cause) {
        setError(messageOf(cause))
      }
      setPressing(false)
    }
  }

  const running = status?.running === true
  const past = id !== undefined

  return (
    <div class="i-screen">
      <header class="i-head">
        <div class="i-head-text">
          <p class="i-when">
            {past
              ? `Check of ${digest ? when(digest.startedAt) : '…'}`
              : digest
                ? `Last checked ${when(digest.startedAt)}`
                : digest === null
                  ? 'Not checked yet'
                  : ' '}
          </p>
          {running && !past ? (
            <p class="i-progress" role="status">
              {progressText(status?.progress)}
            </p>
          ) : null}
        </div>
        {past ? (
          <button type="button" class="btn sm" onClick={() => navigate('')}>
            Latest
          </button>
        ) : (
          <button type="button" class="btn sm i-check" disabled={running || pressing || status === undefined} onClick={() => void checkMail()}>
            Check mail
          </button>
        )}
      </header>

      {error === undefined ? null : (
        <div class="notice err" role="alert">
          <div class="head">Something went wrong</div>
          <p>{error}</p>
        </div>
      )}

      <Accounts accounts={past ? (digest?.accounts ?? []) : accountsOf(status, digest)} />

      {digest === null && !running ? (
        <div class="center-state">
          <h2>No check yet</h2>
          <p>Check mail reads the last 48 hours of your inbox and sorts what needs you from the rest.</p>
        </div>
      ) : null}

      {digest ? <DigestBody digest={digest} past={past} /> : null}

      <footer class="i-foot">
        {digest ? <p class="dim-3">{usageLine(digest)}</p> : null}
        <button type="button" class="i-link" onClick={() => navigate('history')}>
          History
        </button>
      </footer>
    </div>
  )
}

function DigestBody({ digest, past }: { readonly digest: Digest; readonly past: boolean }) {
  const sections = sectionsOf(digest.entries)
  // A past check is read against the day it ran: otherwise every due date in it turns red and late.
  const today = localDay(past ? new Date(digest.startedAt) : new Date())
  return (
    <>
      {digest.state === 'ok' ? null : (
        <div class={digest.state === 'failed' ? 'notice err' : 'notice ask'}>
          <div class="head">{digest.state === 'failed' ? 'This check failed' : 'This check is incomplete'}</div>
          {digest.reason === undefined ? null : <p>{digest.reason}</p>}
        </div>
      )}
      {digest.overflow > 0 ? (
        <p class="dim-2 i-note">{digest.overflow} older mails were left out: a check classifies the newest 400.</p>
      ) : null}

      <div class="i-sections">
        <Section kind="todo" title="To do" count={sections.todo.length} none="nothing asks for you" open>
          <ul class="i-list">
            {sections.todo.map((entry) => (
              <TodoRow key={entry.key} entry={entry} today={today} />
            ))}
          </ul>
        </Section>
        <Section kind="unsub" title="Unsubscribe" count={sections.unsubscribe.length} none="none">
          <ul class="i-list i-small">
            {sections.unsubscribe.map((group) => (
              <SenderRow key={group.address} group={group} />
            ))}
          </ul>
        </Section>
        <Section kind="info" title="Info" count={sections.info.length} none="none">
          <MailRows entries={sections.info} />
        </Section>
        <Section kind="spam" title="Spam" count={sections.spam.length} none="none">
          <MailRows entries={sections.spam} />
        </Section>
        {sections.unclassified.length === 0 ? null : (
          <Section kind="other" title="Unclassified" count={sections.unclassified.length} none="none">
            <MailRows entries={sections.unclassified} />
          </Section>
        )}
      </div>
    </>
  )
}

type SectionKind = 'todo' | 'unsub' | 'info' | 'spam' | 'other'

/** A heading with its colour and count that folds what is under it; with nothing under it, one quiet line. */
function Section(props: {
  readonly kind: SectionKind
  readonly title: string
  readonly count: number
  readonly none: string
  readonly open?: boolean
  readonly children: ComponentChildren
}) {
  const { kind, title, count, none, open = false, children } = props
  const heading = (
    <>
      <span class="i-swatch" aria-hidden="true" />
      <span class="i-name">{title}</span>
      <span class="i-count">{count === 0 ? none : count}</span>
    </>
  )
  if (count === 0) return <div class={`i-sec i-sec-${kind} i-sec-empty`}>{heading}</div>
  return (
    <details class={`i-sec i-sec-${kind}`} open={open}>
      <summary>
        {heading}
        <Icon name="caret-down" size={18} class="i-caret" />
      </summary>
      {children}
    </details>
  )
}

type CopyState = 'idle' | 'copied' | 'failed'

const COPY_LABEL: Readonly<Record<CopyState, string>> = { idle: 'Copy draft', copied: 'Copied', failed: 'Could not copy' }

function TodoRow({ entry, today }: { readonly entry: DigestEntry; readonly today: string }) {
  const [open, setOpen] = useState(false)
  const [copy, setCopy] = useState<CopyState>('idle')
  const due = entry.due === undefined ? undefined : dueText(entry.due, today)
  const ask = entry.ask ?? entry.subject

  useEffect(() => {
    if (copy === 'idle') return
    const timer = setTimeout(() => setCopy('idle'), COPIED_MS)
    return () => clearTimeout(timer)
  }, [copy])

  const copyDraft = async (): Promise<void> => {
    if (entry.draft === undefined) return
    try {
      await navigator.clipboard.writeText(entry.draft)
      setCopy('copied')
    } catch {
      setCopy('failed')
    }
  }

  return (
    <li>
      <div class="i-todo">
        <button type="button" class="i-todo-text" aria-expanded={open} onClick={() => setOpen((was) => !was)}>
          <span class="i-ask">
            {priorityOf(entry) === 'high' ? <span class="i-dot" role="img" aria-label="Urgent" /> : null}
            {ask}
          </span>
          <span class="i-meta">
            {due === undefined ? null : (
              <>
                <span class={due.urgent ? 'i-late' : undefined}>{due.text}</span>
                {' · '}
              </>
            )}
            {metaLine(entry)}
          </span>
        </button>
        <div class="i-acts">
          {entry.draft === undefined ? null : (
            <button
              type="button"
              class={`icon-btn i-icon i-copy-${copy}`}
              aria-label={COPY_LABEL[copy]}
              title={COPY_LABEL[copy]}
              onClick={() => void copyDraft()}
            >
              <Icon name={copy === 'copied' ? 'check' : 'copy'} />
            </button>
          )}
          <span class="sr-only" role="status">
            {copy === 'idle' ? '' : COPY_LABEL[copy]}
          </span>
          {isGmail(entry.link) ? (
            <a class="icon-btn i-icon" href={entry.link} target="_blank" rel="noreferrer noopener" aria-label="Open in Gmail" title="Open in Gmail">
              <Icon name="envelope-simple" />
            </a>
          ) : null}
        </div>
      </div>
      {open ? (
        <div class="i-more">
          {entry.ask === undefined || entry.subject === '' ? null : <p class="i-subject">{entry.subject}</p>}
          {entry.why === undefined ? null : <p class="i-why">{entry.why}</p>}
          {entry.draft === undefined ? null : <pre class="i-draft">{entry.draft}</pre>}
        </div>
      ) : null}
    </li>
  )
}

function SenderRow({ group }: { readonly group: SenderGroup }) {
  return (
    <li class="i-row">
      <span class="i-row-main">{group.sender}</span>
      <span class="dim-2 num">
        {group.count}
        {group.hasUnsubscribe ? '' : ' · no unsubscribe link'}
      </span>
    </li>
  )
}

function MailRows({ entries }: { readonly entries: readonly DigestEntry[] }) {
  return (
    <ul class="i-list i-small">
      {entries.map((entry) => (
        <li key={entry.key} class="i-row i-row-stack">
          <span class="i-row-main">{entry.subject || '(no subject)'}</span>
          <span class="dim-2">
            {senderOf(entry)} · {entry.account}
            {entry.why === undefined ? '' : ` · ${entry.why}`}
          </span>
        </li>
      ))}
    </ul>
  )
}

function Accounts({ accounts }: { readonly accounts: readonly (AccountStatus | { readonly id: string; readonly label: string })[] }) {
  if (accounts.length === 0) return null
  return (
    <div class="i-accounts">
      {accounts.map((account) => {
        const failed = 'state' in account && account.state === 'failed'
        return (
          <span key={account.id} class={failed ? 'chip i-failed' : 'chip'} title={failed ? account.reason : undefined}>
            {account.label}
            {'state' in account ? (failed ? ' · failed' : ` · ${account.eligible}`) : ''}
            {failed && account.reason !== undefined ? <span class="i-reason">{account.reason}</span> : null}
          </span>
        )
      })}
    </div>
  )
}

/** The configured accounts with their last state: before the first check, names only (criterion 2). */
function accountsOf(status: InboxStatus | undefined, digest: Digest | null | undefined): readonly (AccountStatus | { id: string; label: string })[] {
  if (status === undefined) return digest?.accounts ?? []
  return status.accounts.map((account) => account.last ?? { id: account.id, label: account.label })
}

function usageLine(digest: Digest): string {
  const usage = digest.usage
  return [
    `${usage.model}${usage.effort === undefined ? '' : ` (${usage.effort})`}`,
    `${usage.batches} batch${usage.batches === 1 ? '' : 'es'}`,
    `${tokens(usage.inputTokens)} in / ${tokens(usage.outputTokens)} out`,
    `${dollars(usage.costUsd)} equivalent`,
    seconds(usage.ms),
  ].join(' · ')
}

function senderOf(entry: DigestEntry): string {
  const { name, address } = splitFrom(entry.from)
  return name || address
}

/** Today on this device, as `YYYY-MM-DD`: what a due date is compared with. */
function localDay(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export function when(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}

function isGmail(link: string | undefined): link is string {
  return link !== undefined && link.startsWith(GMAIL)
}

function statusOf(cause: unknown): number | undefined {
  const status = (cause as { status?: unknown } | null)?.status
  return typeof status === 'number' ? status : undefined
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
