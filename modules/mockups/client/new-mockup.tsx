/**
 * «New mockup» (criteria 6, 6b, 8): over a project of the vault, or a new one with the scaffold of
 * `/nuevo-proyecto` — title, client, one sentence, difficulty, an optional due date. A work-dir with
 * an open mockup answers 409 with its name; a map that could not be updated is said, not hidden.
 */

import { useEffect, useState } from 'preact/hooks'
import type { Created, ProjectEntry } from '../types.ts'
import type { ViewProps } from './contract.ts'
import { Icon } from './icon.tsx'
import { messageOf } from './launch.ts'

type Kind = 'existing' | 'new'

/** «Acme Portal» → `acme-portal`: the folder and the hub's name. */
export function slugOf(title: string): string {
  return title
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64)
}

export function NewMockup({ props }: { readonly props: ViewProps }) {
  const [projects, setProjects] = useState<readonly ProjectEntry[] | undefined>(undefined)
  const [kind, setKind] = useState<Kind>('existing')
  const [slug, setSlug] = useState('')
  const [name, setName] = useState('')
  const [client, setClient] = useState('')
  const [title, setTitle] = useState('')
  const [summary, setSummary] = useState('')
  const [difficulty, setDifficulty] = useState<'low' | 'medium' | 'high'>('medium')
  const [due, setDue] = useState('')
  const [error, setError] = useState<string | undefined>(undefined)
  const [saving, setSaving] = useState(false)
  const [mapWarning, setMapWarning] = useState<{ readonly id: string; readonly text: string } | undefined>(undefined)

  useEffect(() => {
    props.api
      .get<{ projects: readonly ProjectEntry[] }>('projects')
      .then((answer) => setProjects(answer.projects))
      .catch((cause: unknown) => setError(messageOf(cause)))
  }, [props.api])

  const ready = name.trim() !== '' && client.trim() !== '' && (kind === 'existing' ? slug !== '' : title.trim() !== '' && summary.trim() !== '' && slugOf(title) !== '')
  const create = async (): Promise<void> => {
    setSaving(true)
    setError(undefined)
    const project =
      kind === 'existing'
        ? { kind, slug }
        : { kind, slug: slugOf(title), title: title.trim(), client: client.trim(), summary: summary.trim(), difficulty, ...(due === '' ? {} : { due }) }
    try {
      const created = await props.api.post<Created>('mockups', { name: name.trim(), client: client.trim(), project })
      if (created.mapWarning !== undefined) setMapWarning({ id: created.mockup.id, text: created.mapWarning })
      else props.navigate(created.mockup.id)
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setSaving(false)
    }
  }

  if (mapWarning !== undefined) {
    return (
      <div class="mk-screen mk-form">
        <p class="mk-notice">
          <Icon name="warning" size={16} /> The project was created. {mapWarning.text}
        </p>
        <button type="button" class="btn primary" onClick={() => props.navigate(mapWarning.id)}>
          Open the mockup
        </button>
      </div>
    )
  }

  return (
    <div class="mk-screen">
      <header class="mk-bar">
        <button type="button" class="btn quiet mk-icon-btn" aria-label="Back to the mockups" onClick={() => props.navigate('')}>
          <Icon name="caret-left" size={18} />
        </button>
        <h2 class="mk-title">New mockup</h2>
      </header>
      <div class="mk-form">
        <label class="mk-field">
          <span>Name of the mockup</span>
          <input value={name} maxLength={80} onInput={(e) => setName((e.currentTarget as HTMLInputElement).value)} />
          <span class="mk-cap">It goes in the push: if the client's name is sensitive, use another.</span>
        </label>
        <label class="mk-field">
          <span>Client</span>
          <input value={client} maxLength={80} onInput={(e) => setClient((e.currentTarget as HTMLInputElement).value)} />
        </label>
        <div class="mk-row" role="radiogroup" aria-label="Project">
          <button type="button" role="radio" aria-checked={kind === 'existing'} class={`btn sm${kind === 'existing' ? ' primary' : ''}`} onClick={() => setKind('existing')}>
            Existing project
          </button>
          <button type="button" role="radio" aria-checked={kind === 'new'} class={`btn sm${kind === 'new' ? ' primary' : ''}`} onClick={() => setKind('new')}>
            New project
          </button>
        </div>
        {kind === 'existing' ? (
          <label class="mk-field">
            <span>Project of the vault</span>
            <select value={slug} onChange={(e) => setSlug((e.currentTarget as HTMLSelectElement).value)}>
              <option value="">{projects === undefined ? 'Reading the projects…' : 'Choose one'}</option>
              {(projects ?? []).map((p) => (
                <option key={p.slug} value={p.slug} disabled={p.workDir === null}>
                  {p.title}
                  {p.workDir === null ? ' (no work-dir)' : ''}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <>
            <label class="mk-field">
              <span>Project title</span>
              <input value={title} onInput={(e) => setTitle((e.currentTarget as HTMLInputElement).value)} />
              {title === '' ? null : <span class="mk-cap mk-mono">01-projects/{slugOf(title)}</span>}
            </label>
            <label class="mk-field">
              <span>One sentence: what it is</span>
              <textarea value={summary} onInput={(e) => setSummary((e.currentTarget as HTMLTextAreaElement).value)} />
            </label>
            <div class="mk-row mk-wrap">
              <label class="mk-field">
                <span>Difficulty</span>
                <select value={difficulty} onChange={(e) => setDifficulty((e.currentTarget as HTMLSelectElement).value as 'low' | 'medium' | 'high')}>
                  <option value="low">low</option>
                  <option value="medium">medium</option>
                  <option value="high">high</option>
                </select>
              </label>
              <label class="mk-field">
                <span>Due (optional)</span>
                <input type="date" value={due} onInput={(e) => setDue((e.currentTarget as HTMLInputElement).value)} />
              </label>
            </div>
          </>
        )}
        {error === undefined ? null : <p class="mk-notice mk-err">{error}</p>}
        <button type="button" class="btn primary mk-big" disabled={!ready || saving} onClick={() => void create()}>
          {saving ? 'Creating…' : 'Create the mockup'}
        </button>
      </div>
    </div>
  )
}
