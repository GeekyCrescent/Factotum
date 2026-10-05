/**
 * The history: every kept check, newest first, with its state and how many to-dos it found
 * (spec 2026-10-05, D9; criterion 24). A tap opens `/m/inbox/<id>`.
 */

import { useEffect, useState } from 'preact/hooks'
import type { DigestSummary } from '../types.ts'
import type { ViewProps } from './contract.ts'
import { when } from './digest-view.tsx'

const LIMIT = 30

export function History({ view }: { readonly view: ViewProps }) {
  const { api, navigate } = view
  const [digests, setDigests] = useState<readonly DigestSummary[] | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)

  useEffect(() => {
    let live = true
    api
      .get<{ digests: DigestSummary[] }>(`digests?limit=${LIMIT}`)
      .then((body) => {
        if (live) setDigests(body.digests)
      })
      .catch((cause: unknown) => {
        if (live) setError(cause instanceof Error ? cause.message : String(cause))
      })
    return () => {
      live = false
    }
  }, [api])

  return (
    <div class="i-screen">
      <header class="i-head">
        <div class="i-head-text">
          <p class="i-when">History</p>
        </div>
        <button type="button" class="btn" onClick={() => navigate('')}>
          Latest
        </button>
      </header>
      {error === undefined ? null : (
        <div class="notice err" role="alert">
          <div class="head">Could not load the history</div>
          <p>{error}</p>
        </div>
      )}
      {digests !== undefined && digests.length === 0 ? <p class="dim-2">No checks kept yet.</p> : null}
      <ul class="i-rows">
        {(digests ?? []).map((digest) => (
          <li key={digest.id}>
            <button type="button" class="i-row i-row-button" onClick={() => navigate(digest.id)}>
              <span class="i-row-main">{when(digest.startedAt)}</span>
              <span class={`dim-2 i-state i-state-${digest.state}`}>
                {digest.state === 'ok' ? '' : `${digest.state} · `}
                {digest.todo} to do · {digest.high} high
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
