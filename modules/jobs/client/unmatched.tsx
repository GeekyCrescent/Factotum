/**
 * «Unmatched reply» cards on the tracker (spec 2026-11-12-postulaciones, tasks Q5; requirements crit.
 * 56; design D12 rule 4): a mail that looks like a job's and matched no application — sender, subject,
 * the date of the mail, «Open in Gmail» — with «Assign to…» and «Ignore». Through the tracker's lock,
 * as its other actions. What decides is `unmatched-model.ts`.
 */

import { useCallback, useEffect, useRef, useState } from 'preact/hooks'
import type { Api, UnmatchedAnswer, UnmatchedReply } from './contract.ts'
import { runOrSay, type Lock } from './guard.ts'
import { refusalOf, safeHref } from './model.ts'
import { assignChoices, unmatchedHeading } from './unmatched-model.ts'

const GMAIL = 'https://mail.google.com/'

const dayOf = (iso: string): string => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })

export function UnmatchedReplies({ api, lock, onAssigned }: { readonly api: Api; readonly lock: Lock; readonly onAssigned: () => void }) {
  const [answer, setAnswer] = useState<UnmatchedAnswer | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const load = useCallback(async () => {
    try {
      const read = await api.get<UnmatchedAnswer>('replies/unmatched')
      if (alive.current) setAnswer(read)
    } catch (cause) {
      if (alive.current) setError(refusalOf(cause).text)
    }
  }, [api])
  useEffect(() => void load(), [load])

  const settle = async (key: string, applicationId: string | null): Promise<void> => {
    await runOrSay(lock, async () => {
      setBusy(true)
      try {
        await api.post(`replies/${encodeURIComponent(key)}/assign`, { applicationId })
        setError(null)
        await load()
        if (applicationId !== null) onAssigned()
      } catch (cause) {
        setError(refusalOf(cause).text)
      } finally {
        setBusy(false)
      }
    }, setError)
  }

  const heading = unmatchedHeading(answer?.replies.length ?? 0)
  if (heading === null && error === null) return null
  return (
    <section class="j-unmatched" aria-label="Unmatched replies">
      {heading === null ? null : <h2 class="j-unmatched-head">{heading}</h2>}
      {error === null ? null : (
        <div class="notice err" role="alert">
          <p>{error}</p>
        </div>
      )}
      {answer?.replies.map((reply) => (
        <Card key={reply.key} reply={reply} answer={answer} busy={busy} onSettle={settle} />
      ))}
    </section>
  )
}

function Card({ reply, answer, busy, onSettle }: { readonly reply: UnmatchedReply; readonly answer: UnmatchedAnswer; readonly busy: boolean; readonly onSettle: (key: string, applicationId: string | null) => Promise<void> }) {
  const choices = assignChoices(reply, answer.applications)
  const [chosen, setChosen] = useState<string>(choices[0]?.id ?? '')
  const link = safeHref(reply.link, GMAIL)
  return (
    <article class="j-unmatched-card">
      <p class="j-unmatched-subject">{reply.subject === '' ? '(no subject)' : reply.subject}</p>
      <p class="j-quiet">
        From {reply.from} · {dayOf(reply.at)}
      </p>
      {reply.summary === null ? null : <p class="j-text">{reply.summary}</p>}
      <div class="j-unmatched-acts">
        {choices.length === 0 ? null : (
          <>
            <label class="j-quiet" for={`assign-${reply.key}`}>
              Assign to…
            </label>
            <select id={`assign-${reply.key}`} value={chosen} disabled={busy} onChange={(event) => setChosen((event.target as HTMLSelectElement).value)}>
              {choices.map((choice) => (
                <option key={choice.id} value={choice.id}>
                  {choice.suggested ? `${choice.label} (matched)` : choice.label}
                </option>
              ))}
            </select>
            <button type="button" class="btn sm primary" disabled={busy || chosen === ''} onClick={() => void onSettle(reply.key, chosen)}>
              Assign
            </button>
          </>
        )}
        <button type="button" class="btn sm" disabled={busy} onClick={() => void onSettle(reply.key, null)}>
          Ignore
        </button>
        {link === null ? null : (
          <a class="btn sm" href={link} target="_blank" rel="noopener noreferrer">
            Open in Gmail
          </a>
        )}
      </div>
    </article>
  )
}
