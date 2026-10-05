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
 * TEXT ONLY: no glyphs on this screen (D9). The envelope in the nav is the shell's.
 */

import { useCallback, useEffect, useState } from 'preact/hooks'
import type { AccountStatus, Digest, DigestEntry, InboxStatus } from '../types.ts'
import type { ViewProps } from './contract.ts'
import { dollars, metaLine, priorityOf, progressText, sectionsOf, seconds, splitFrom, tokens, type SenderGroup } from './model.ts'

const POLL_MS = 2_000

export function DigestView({ view, id }: { readonly view: ViewProps; readonly id?: string }) {
  const { api, navigate } = view
  const [status, setStatus] = useState<InboxStatus | undefined>(undefined)
  /** `null`: there is none yet (404). `undefined`: not loaded. */
  const [digest, setDigest] = useState<Digest | null | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [pressing, setPressing] = useState(false)

  const loadStatus = useCallback(async (): Promise<InboxStatus> => {
    const next = await api.get<InboxStatus>('status')
    setStatus(next)
    return next
  }, [api])

  const loadDigest = useCallback(async (): Promise<void> => {
    try {
      setDigest(await api.get<Digest>(id === undefined ? 'digests/latest' : `digests/${encodeURIComponent(id)}`))
      setError(undefined)
    } catch (cause) {
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
          if (live) setError(messageOf(cause))
        })
    }, POLL_MS)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [status, loadStatus, loadDigest, id])

  const checkMail = async (): Promise<void> => {
    setPressing(true)
    try {
      await api.post('run')
      setError(undefined)
    } catch (cause) {
      // 409: one is already going — the status below shows it, which is all the owner needs.
      if (statusOf(cause) !== 409) setError(messageOf(cause))
    } finally {
      await loadStatus().catch((cause: unknown) => setError(messageOf(cause)))
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
          <button type="button" class="btn" onClick={() => navigate('')}>
            Latest
          </button>
        ) : (
          <button type="button" class="btn primary" disabled={running || pressing || status === undefined} onClick={() => void checkMail()}>
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

      {digest ? <DigestBody digest={digest} /> : null}

      <footer class="i-foot">
        {digest ? <p class="dim-3">{usageLine(digest)}</p> : null}
        <button type="button" class="i-link" onClick={() => navigate('history')}>
          History
        </button>
      </footer>
    </div>
  )
}

function DigestBody({ digest }: { readonly digest: Digest }) {
  const sections = sectionsOf(digest.entries)
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

      <section class="i-section">
        <h2>To do ({sections.todo.length})</h2>
        {sections.todo.length === 0 ? <p class="dim-2">Nothing asks for you.</p> : null}
        {sections.todo.map((entry) => (
          <TodoCard key={entry.key} entry={entry} />
        ))}
      </section>

      <section class="i-section">
        <h2>Unsubscribe ({sections.unsubscribe.length} senders)</h2>
        {sections.unsubscribe.length === 0 ? <p class="dim-2">No bulk mail worth leaving.</p> : null}
        <ul class="i-rows">
          {sections.unsubscribe.map((group) => (
            <SenderRow key={group.address} group={group} />
          ))}
        </ul>
      </section>

      <Folded title="Spam" entries={sections.spam} />
      <Folded title="Info" entries={sections.info} />
      {sections.unclassified.length === 0 ? null : <Folded title="Unclassified" entries={sections.unclassified} />}
    </>
  )
}

function TodoCard({ entry }: { readonly entry: DigestEntry }) {
  const [copied, setCopied] = useState(false)
  const priority = priorityOf(entry)
  const copy = async (): Promise<void> => {
    if (entry.draft === undefined) return
    try {
      await navigator.clipboard.writeText(entry.draft)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }
  return (
    <article class="i-card">
      <p class="i-ask">
        <span class={`i-pri i-pri-${priority}`}>{priority}</span> {entry.ask ?? entry.subject}
      </p>
      <p class="i-meta">{metaLine(entry)}</p>
      <p class="i-subject">{entry.subject}</p>
      {entry.why === undefined ? null : <p class="i-why">{entry.why}</p>}
      {entry.draft === undefined ? (
        entry.link === undefined ? null : (
          <div class="i-acts">
            <OpenLink link={entry.link} />
          </div>
        )
      ) : (
        <details class="i-draft">
          <summary>Draft</summary>
          <pre>{entry.draft}</pre>
          <div class="i-acts">
            <button type="button" class="btn" onClick={() => void copy()}>
              {copied ? 'Copied' : 'Copy'}
            </button>
            {entry.link === undefined ? null : <OpenLink link={entry.link} />}
          </div>
        </details>
      )}
    </article>
  )
}

function OpenLink({ link }: { readonly link: string }) {
  return (
    <a class="btn" href={link} target="_blank" rel="noreferrer noopener">
      Open in Gmail
    </a>
  )
}

function SenderRow({ group }: { readonly group: SenderGroup }) {
  return (
    <li class="i-row">
      <span class="i-row-main">{group.sender}</span>
      <span class="dim-2 num">
        {group.count} mail{group.count === 1 ? '' : 's'}
        {group.hasUnsubscribe ? ' · has unsubscribe link' : ''}
      </span>
    </li>
  )
}

function Folded({ title, entries }: { readonly title: string; readonly entries: readonly DigestEntry[] }) {
  return (
    <details class="i-section i-fold">
      <summary>
        {title} ({entries.length})
      </summary>
      <ul class="i-rows">
        {entries.map((entry) => (
          <li key={entry.key} class="i-row i-row-stack">
            <span class="i-row-main">{entry.subject || '(no subject)'}</span>
            <span class="dim-2">
              {senderOf(entry)} · {entry.account}
              {entry.why === undefined ? '' : ` — ${entry.why}`}
            </span>
          </li>
        ))}
      </ul>
    </details>
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

export function when(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}

function statusOf(cause: unknown): number | undefined {
  const status = (cause as { status?: unknown } | null)?.status
  return typeof status === 'number' ? status : undefined
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
