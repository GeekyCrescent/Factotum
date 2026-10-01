/**
 * The composer's project, chosen in a sheet instead of the system's `<select>` (2026-10-01): a search
 * on top, the owner's categories as filters under it, and the projects grouped by category with
 * their colour and folder. On a phone the sheet comes up from the bottom; on a computer it is a
 * dialog in the middle — the shell's `.sheet` already does both.
 *
 * The categories come from `GET projects`, asked again every time the sheet opens. Until it answers,
 * or if it fails, the list is flat: choosing a project never waits on it. What to list and in what
 * order is `project-choice.ts`.
 */

import { useCallback, useEffect, useState } from 'preact/hooks'
import type { ProjectsPage } from '../types.ts'
import type { Api } from './contract.ts'
import { shortPath } from './format.ts'
import { Icon } from './icon.tsx'
import { choiceGroupsOf, firstChoice, type Arrangement, type ChoiceGroup, type ChoiceSite, type Scope } from './project-choice.ts'
import { Sheet } from './sheet.tsx'
import { toneClass } from './tone.ts'

const ALL: Scope = { kind: 'all' }

/** A mouse or a trackpad: the search takes focus. */
const FINE_POINTER = '(pointer: fine)'

export type Loaded =
  | { readonly kind: 'waiting' }
  | { readonly kind: 'ok'; readonly arrangement: Arrangement; readonly home: string }
  | { readonly kind: 'failed' }

function arrangementOf(page: ProjectsPage): Arrangement {
  return { categories: page.categories, projects: page.projects.map((p) => ({ id: p.id, category: p.category })) }
}

/** `GET projects` each time it is asked for; the last good answer stays while a new one is on its way. */
export function useArrangement(api: Api) {
  const [loaded, setLoaded] = useState<Loaded>({ kind: 'waiting' })
  const load = useCallback(() => {
    api
      .get<ProjectsPage>('projects')
      .then((page) => setLoaded({ kind: 'ok', arrangement: arrangementOf(page), home: page.home }))
      .catch(() => setLoaded((before) => (before.kind === 'ok' ? before : { kind: 'failed' })))
  }, [api])
  useEffect(load, [load])
  return { loaded, load }
}

/** The chip in the composer's row. The sheet is rendered OUTSIDE the box's form: see `LaunchComposer`. */
export function ProjectButton({ site, onOpen }: { readonly site: ChoiceSite | undefined; readonly onOpen: () => void }) {
  return (
    <button
      type="button"
      class="chip s-pick s-pp-btn"
      aria-haspopup="dialog"
      aria-label={`Project: ${site === undefined ? 'none' : labelOf(site)}`}
      onClick={onOpen}
    >
      {site === undefined ? (
        <Icon name="folder-simple" size={16} />
      ) : (
        <span class={`s-pp-dot ${toneClass(site.id, site.color)}`} aria-hidden="true" />
      )}
      <span class="s-pp-name">{site === undefined ? 'Project' : labelOf(site)}</span>
      <Icon name="caret-down" size={12} />
    </button>
  )
}

export function ProjectSheet({
  sites,
  value,
  loaded,
  onClose,
  onPick,
}: {
  readonly sites: readonly ChoiceSite[]
  readonly value: string
  readonly loaded: Loaded
  readonly onClose: () => void
  readonly onPick: (siteId: string) => void
}) {
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState<Scope>(ALL)
  const arrangement = loaded.kind === 'ok' ? loaded.arrangement : undefined
  const home = loaded.kind === 'ok' ? loaded.home : ''
  const groups = choiceGroupsOf(sites, arrangement, query, scope)
  // The filters are the groups there are with no search: a category with nothing to launch is no filter.
  const scopes = choiceGroupsOf(sites, arrangement, '', ALL)
  const showsHeaders = scopes.some((group) => group.category !== undefined)
  return (
    <Sheet id="s-project-sheet-title" title="Choose a project" onClose={onClose}>
      <label class="s-search s-pp-search">
        <Icon name="magnifying-glass" size={16} />
        <input
          type="search"
          value={query}
          placeholder="Search by name, folder or category…"
          aria-label="Search projects"
          // On a phone the keyboard would cover the list it opened to show: there the title takes focus.
          autoFocus={window.matchMedia(FINE_POINTER).matches}
          onInput={(event) => setQuery((event.target as HTMLInputElement).value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || event.isComposing) return
            event.preventDefault()
            const first = firstChoice(groups)
            if (first !== undefined) onPick(first.id)
          }}
        />
      </label>
      {showsHeaders ? <Scopes scopes={scopes} scope={scope} setScope={setScope} /> : null}
      {loaded.kind === 'failed' ? <p class="s-none">Categories could not be loaded; showing every project.</p> : null}
      <div class="s-pp-list">
        {groups.length === 0 ? <p class="s-none">No project matches.</p> : null}
        {groups.map((group) => (
          <Group key={group.category?.id ?? ''} group={group} header={showsHeaders} value={value} home={home} onPick={onPick} />
        ))}
      </div>
    </Sheet>
  )
}

function Scopes({
  scopes,
  scope,
  setScope,
}: {
  readonly scopes: readonly ChoiceGroup[]
  readonly scope: Scope
  readonly setScope: (scope: Scope) => void
}) {
  const options: readonly { readonly key: string; readonly label: string; readonly scope: Scope }[] = [
    { key: 'all', label: 'All', scope: ALL },
    ...scopes.map((group) =>
      group.category === undefined
        ? { key: 'loose', label: 'No category', scope: { kind: 'loose' } as const }
        : { key: `c:${group.category.id}`, label: group.category.name, scope: { kind: 'category', id: group.category.id } as const },
    ),
  ]
  return (
    <div class="s-pp-scopes" role="group" aria-label="Filter by category">
      {options.map((option) => (
        <button
          type="button"
          key={option.key}
          class="chip"
          aria-pressed={sameScope(option.scope, scope)}
          onClick={() => setScope(option.scope)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

function Group({
  group,
  header,
  value,
  home,
  onPick,
}: {
  readonly group: ChoiceGroup
  readonly header: boolean
  readonly value: string
  readonly home: string
  readonly onPick: (siteId: string) => void
}) {
  const title = group.category?.name ?? 'No category'
  return (
    <section class="s-pp-group" aria-label={header ? title : 'Projects'}>
      {header ? (
        <h3 class="s-pp-head">
          {title}
          <span class="s-pp-count">{group.sites.length}</span>
        </h3>
      ) : null}
      <ul class="s-pp-rows">
        {group.sites.map((site) => {
          const chosen = site.id === value
          return (
            <li key={site.id}>
              <button
                type="button"
                class={`s-pp-row ${toneClass(site.id, site.color)}`}
                aria-current={chosen ? 'true' : undefined}
                onClick={() => onPick(site.id)}
              >
                <span class="s-pp-dot" aria-hidden="true" />
                <span class="s-pp-text">
                  <span class="s-pp-name">{labelOf(site)}</span>
                  <span class="s-pp-path">{home === '' ? site.path : shortPath(site.path, home)}</span>
                </span>
                {chosen ? <Icon name="check" size={16} /> : null}
              </button>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

function labelOf(site: ChoiceSite): string {
  return site.name ?? site.id
}

function sameScope(a: Scope, b: Scope): boolean {
  if (a.kind !== b.kind) return false
  return a.kind !== 'category' || (b.kind === 'category' && a.id === b.id)
}
