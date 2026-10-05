/**
 * `/m/sessions/skills`: what you can launch with «/», and what you have used (spec 2026-10-03-skills-a-mano,
 * D10). READ ONLY: nothing is pinned or launched from here.
 *
 * Two reads in parallel, the list (no `site`, so no pins) and the usage of the last 30 days. From the top:
 * the header, the used, the never used (all of them: it is the reminder of what exists and is not used), and
 * two folds, «Unsorted» and «In the note, not installed».
 */

import { useEffect, useState } from 'preact/hooks'
import type { SkillEntryView, SkillsView } from '../skills/arrange.ts'
import { TopBar } from './bars.tsx'
import type { ViewProps } from './contract.ts'
import { messageOf } from './errors.ts'
import { ago } from './format.ts'
import { Icon } from './icon.tsx'
import { neverUsed, unsortedOf, usedRows, whoLine, type UsageAnswer } from './usage-view.ts'

const DAYS = 30

function sinceLine(list: SkillsView['list'], now: number): string {
  if (list.state === 'unknown') return 'No list yet'
  const when = ago(list.since, now)
  return when === '' ? 'List unchanged' : `List unchanged since ${when === 'now' ? 'just now' : `${when} ago`}`
}

function lastUsed(iso: string | undefined, now: number): string {
  if (iso === undefined) return ''
  const when = ago(iso, now)
  return when === 'now' ? 'just now' : `${when} ago`
}

function EntryRow({ entry }: { readonly entry: SkillEntryView }) {
  const line = [entry.why, entry.when].filter((part) => part !== undefined).join(' · ')
  return (
    <li class="s-use-row">
      <span class="mono s-use-name">{entry.name}</span>
      <span class="dim-2 s-use-kind">{entry.kind}</span>
      {line === '' ? null : <span class="dim-2 s-use-when">{line}</span>}
    </li>
  )
}

export function SkillsScreen({ view }: { readonly view: ViewProps }) {
  const { api } = view
  const [skills, setSkills] = useState<SkillsView | undefined>(undefined)
  const [usage, setUsage] = useState<UsageAnswer | undefined>(undefined)
  const [loadError, setLoadError] = useState<string | undefined>(undefined)
  const [now] = useState(() => Date.now())

  useEffect(() => {
    let isCurrent = true
    Promise.all([api.get<SkillsView>('skills'), api.get<UsageAnswer>(`skills/usage?days=${DAYS}`)]).then(
      ([listed, used]) => {
        if (!isCurrent) return
        setSkills(listed)
        setUsage(used)
        setLoadError(undefined)
      },
      (cause: unknown) => {
        if (isCurrent) setLoadError(messageOf(cause))
      },
    )
    return () => {
      isCurrent = false
    }
  }, [api])

  const ready = skills !== undefined && usage !== undefined
  const used = ready ? usedRows(usage.counts) : []
  const never = ready ? neverUsed(skills, usage.counts) : []
  const unsorted = ready ? unsortedOf(skills) : []

  return (
    <div class="s-screen">
      <TopBar title="Settings" pendingTotal={view.pendingTotal} onMenu={view.openDrawer} />
      <div class="s-body s-projects">
        <header class="s-page-head">
          <div>
            <h1>Skills</h1>
            <p>
              Last {DAYS} days{ready ? ` · ${sinceLine(skills.list, now)}` : ''}
            </p>
          </div>
        </header>

        {loadError === undefined ? null : (
          <div class="notice err" role="alert">
            <div class="head">
              <Icon name="warning" size={16} />
              Could not load the skills: {loadError}
            </div>
          </div>
        )}
        {ready || loadError !== undefined ? null : <p class="dim-3">Loading…</p>}

        {!ready ? null : skills.list.state === 'unknown' ? (
          <p class="s-empty">Nothing is known yet: run any conversation and the CLI will say what it can launch.</p>
        ) : (
          <>
            {skills.notes.state !== 'ok' ? (
              <p class="dim-2" role="status">
                The note is {skills.notes.state}{skills.notes.reason === undefined ? '' : `: ${skills.notes.reason}`}.
              </p>
            ) : null}
            {skills.notes.warnings.map((warning) => (
              <p key={warning} class="dim-2" role="status">
                {warning}
              </p>
            ))}

            <section class="s-section">
              <h2 class="s-section-title">Used</h2>
              {used.length === 0 ? <p class="dim-2">Nothing used in this period.</p> : null}
              <ul class="s-use-list">
                {used.map((count) => (
                  <li key={count.name} class="s-use-row">
                    <span class="mono s-use-name">{count.name}</span>
                    <span class="s-use-who">{whoLine(count)}</span>
                    <span class="dim-2 s-use-when">{lastUsed(count.lastUsedAt, now)}</span>
                  </li>
                ))}
              </ul>
            </section>

            <section class="s-section">
              <h2 class="s-section-title">Never used</h2>
              {never.length === 0 ? <p class="dim-2">Everything the list shows was used.</p> : null}
              {never.map((group) => (
                <div key={group.label} class="s-use-group">
                  <h3 class="s-use-group-title">{group.label}</h3>
                  <ul class="s-use-list">
                    {group.entries.map((entry) => (
                      <EntryRow key={`${entry.kind}:${entry.name}`} entry={entry} />
                    ))}
                  </ul>
                </div>
              ))}
            </section>

            <section class="s-section">
              <details class="s-fold">
                <summary>Unsorted ({unsorted.length})</summary>
                <ul class="s-use-list">
                  {unsorted.map((entry) => (
                    <EntryRow key={`${entry.kind}:${entry.name}`} entry={entry} />
                  ))}
                </ul>
              </details>
              <details class="s-fold">
                <summary>In the note, not installed ({skills.stale.length})</summary>
                <ul class="s-use-list">
                  {skills.stale.map((name) => (
                    <li key={name} class="s-use-row">
                      <span class="mono s-use-name">{name}</span>
                    </li>
                  ))}
                </ul>
              </details>
            </section>
          </>
        )}
      </div>
    </div>
  )
}
