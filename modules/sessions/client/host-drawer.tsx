/**
 * ONE HOST'S PART OF THE DRAWER (spec 2026-10-07-dos-hosts, design D12): everything the drawer listed
 * before there were two hosts, now once per host, each talking to its own host through the `api` it
 * is given (`apiOn(host)`). Moved as it was out of `drawer.tsx`, which keeps New session, the search
 * box and one of these per host.
 *
 * EACH ACTION GOES TO ITS GROUP'S HOST (requirements §8, v3.3): the projects, "Show more", the
 * search, the categories, a conversation's menu and the selection. A selection never mixes hosts: the
 * drawer lets one host select at a time (`selecting`).
 *
 * The rest is as it was (spec 2026-09-29, D9; 2026-09-30): its own `GET projects`, when it becomes
 * visible and every REFRESH_MS while it stays so; "Show more" pages through `GET sessions?site=`; the
 * search filters what is loaded and asks the daemon for the rest (`search-results.tsx`). A RIGHT-CLICK
 * (a long press on a phone) on a conversation opens its menu: Select, Rename, Archive, Delete.
 *
 * THE OWNER ARRANGES THE PROJECTS: dragged by their grip (`drag.ts`), or moved a step at a time from
 * their menu or the arrow keys, into categories that fold like a project does — folded per device,
 * the arrangement itself in the daemon, so the phone and the Mac show the same (`use-layout.ts`).
 * Categories first, projects in none loose at the bottom. Not while searching or selecting: what is
 * on screen then is not the whole list, and a drop there would land somewhere the owner cannot see.
 *
 * NO CONSOLE (criterion 41): the pendings it lists may hold tokens, and the search is typed here.
 */

import { useCallback, useEffect, useRef, useState } from 'preact/hooks'
import type { CategoryEntry, ProjectsPage, SessionPage, SessionState, SessionSummary } from '../types.ts'
import { CategoryBlock, CategoryNameSheet, Grip, markClass, MoveToCategorySheet, type DropMark } from './categories.tsx'
import type { Api } from './contract.ts'
import { messageOf } from './errors.ts'
import { ago, day } from './format.ts'
import { history, type Entry, type Group, type Waiting } from './history.ts'
import { Icon } from './icon.tsx'
import type { SessionIcon } from './icons.ts'
import { ContextMenu, MenuItem, useLongPress, type MenuAt } from './context-menu.tsx'
import { ConversationSheet } from './conversation-menu.tsx'
import { useDrag, type Dragging } from './drag.ts'
import {
  addCategory,
  arrange,
  moveCategory,
  moveProject,
  newCategoryId,
  placeOf,
  removeCategory,
  renameCategory,
  stepCategory,
  stepProject,
  type Layout,
} from './layout.ts'
import { ConfirmSheet } from './project-forms.tsx'
import { questionsLabel } from './questions.ts'
import { grantOf, questionsOf, sessionOf, type Pending } from './relevance.ts'
import { SearchResults } from './search-results.tsx'
import { toneClass } from './tone.ts'
import { useProjectLayout } from './use-layout.ts'

const REFRESH_MS = 5_000
const TICK_MS = 1_000
/** The projects the owner folded on this device; a peer's under its own key (`foldedKey`). */
const FOLDED_KEY = 'factotum.sessions.folded'
/** The categories the owner folded on this device. Apart from the projects': an id may be in both. */
const CATEGORIES_FOLDED_KEY = 'factotum.sessions.categories.folded'

/**
 * The serving host keeps the keys it always had, so nothing folded before two hosts unfolds; a peer
 * gets its own, since the same project id may live on both.
 */
const foldedKey = (key: string, host: string | undefined): string => (host === undefined ? key : `${key}@${host}`)

const GLYPH: Readonly<Record<SessionState, SessionIcon>> = {
  running: 'circle-notch',
  finished: 'check-circle',
  failed: 'x-circle',
  cancelled: 'minus-circle',
}

interface RowState {
  readonly rest: string
  readonly now: number
  readonly selecting: boolean
  readonly picked: ReadonlySet<string>
  readonly onPick: (id: string) => void
  readonly navigate: (rest: string) => void
  readonly onMenu: (entry: Entry, at: MenuAt) => void
}

type Acting = { readonly kind: 'rename' | 'delete'; readonly entry: Entry }

/** What arranging asks through a sheet. */
type Arranging =
  | { readonly kind: 'new'; readonly project: string | undefined }
  | { readonly kind: 'rename' | 'delete'; readonly category: CategoryEntry }
  | { readonly kind: 'move'; readonly project: string; readonly label: string }

interface MenuChoice {
  readonly icon: SessionIcon
  readonly label: string
  readonly danger?: boolean
  readonly disabled: boolean
  readonly choose: () => void
}

/** What a project's section needs to be dragged and arranged. */
interface Arrange {
  readonly canMove: boolean
  readonly mark: (id: string) => DropMark
  readonly dragged: (id: string) => boolean
  readonly start: (id: string, event: PointerEvent) => void
  readonly step: (id: string, delta: -1 | 1) => void
  readonly menu: (id: string, label: string, at: MenuAt) => void
}

export interface HostDrawerProps {
  /** This module on this section's host. */
  readonly api: Api
  /** The host, as `apiOn` takes it: `undefined` for the serving one. */
  readonly host: string | undefined
  readonly rest: string
  /** To a conversation or a screen ON THIS HOST. */
  readonly navigate: (rest: string) => void
  /** This host's pendings only. */
  readonly pending: readonly Pending[]
  /** The drawer's one search box. */
  readonly query: string
  /** Whether THIS host is the one selecting; the drawer lets one at a time. */
  readonly selecting: boolean
  readonly onSelecting: (on: boolean) => void
}

export function HostDrawer({ api, host, rest, navigate, pending, query, selecting, onSelecting }: HostDrawerProps) {
  const [page, setPage] = useState<ProjectsPage | undefined>(undefined)
  const [more, setMore] = useState<ReadonlyMap<string, { readonly sessions: readonly SessionSummary[]; readonly next: number }>>(new Map())
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set())
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const [generation, setGeneration] = useState(0)
  const [menu, setMenu] = useState<{ readonly entry: Entry; readonly at: MenuAt } | undefined>(undefined)
  const [acting, setActing] = useState<Acting | undefined>(undefined)
  const [arranging, setArranging] = useState<Arranging | undefined>(undefined)
  const [layoutMenu, setLayoutMenu] = useState<{ readonly at: MenuAt; readonly items: readonly MenuChoice[] } | undefined>(undefined)
  const root = useRef<HTMLDivElement>(null)
  const closeMenu = useCallback(() => setMenu(undefined), [])
  const closeLayoutMenu = useCallback(() => setLayoutMenu(undefined), [])
  const closeArranging = useCallback(() => setArranging(undefined), [])
  // Never throws: a failed read leaves the list as it was, as the poll below does.
  const refetch = useCallback(async () => {
    try {
      setPage(await api.get<ProjectsPage>('projects'))
    } catch {
      // the next poll tries again
    }
  }, [api])
  const reload = () => {
    setMore(new Map())
    setGeneration((n) => n + 1)
  }

  useEffect(() => {
    let live = true
    let fetchedAt = 0
    let wasVisible = false
    const tick = (first = false) => {
      const element = root.current
      const visible = element !== null && element.checkVisibility?.({ visibilityProperty: true }) !== false
      // Once at mount whatever happens, so the list is there the moment the drawer slides in.
      const due = first || (visible && (!wasVisible || Date.now() - fetchedAt >= REFRESH_MS))
      wasVisible = visible
      if (!due) return
      fetchedAt = Date.now()
      api
        .get<ProjectsPage>('projects')
        .then((next) => {
          if (live) setPage(next)
        })
        .catch(() => undefined) // the list stays as it was; the screen itself reports failures
    }
    tick(true)
    const timer = setInterval(() => tick(), TICK_MS)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [api, generation])

  const projects = page?.projects ?? []
  const groups = history(projects, new Map([...more].map(([id, m]) => [id, m.sessions])), waitingOf(pending), query)
  const { folded, toggle } = useFolded(foldedKey(FOLDED_KEY, host))
  const categoriesFolded = useFolded(foldedKey(CATEGORIES_FOLDED_KEY, host))
  const { layout, change, failure: layoutFailure } = useProjectLayout(api, page, refetch)
  const grants = pending.flatMap((p) => grantOf(p) ?? [])
  const searching = query.trim() !== ''
  const labelOf = (id: string) => projects.find((p) => p.id === id)?.name ?? id
  const colorOf = (id: string) => projects.find((p) => p.id === id)?.color
  const blocks = arrange(groups, layout, searching)

  const onDrop = (drag: Dragging) => {
    if (drag.kind === 'category') {
      if (drag.index !== undefined) change(moveCategory(layout, drag.id, drag.index))
      return
    }
    const place = drag.drop === undefined ? undefined : placeOf(layout, drag.id, drag.drop)
    if (place !== undefined) change(moveProject(layout, drag.id, place))
  }
  const { dragging, start } = useDrag(root, onDrop)

  const showMore = async (siteId: string) => {
    const next = more.get(siteId)?.next ?? 0
    try {
      const got = await api.get<SessionPage>(`sessions?site=${encodeURIComponent(siteId)}&page=${next}`)
      setMore((current) => {
        const copy = new Map(current)
        copy.set(siteId, { sessions: [...(current.get(siteId)?.sessions ?? []), ...got.sessions], next: next + 1 })
        return copy
      })
    } catch (cause: unknown) {
      setFailure(messageOf(cause))
    }
  }

  const onPick = (id: string) =>
    setPicked((current) => {
      const copy = new Set(current)
      if (copy.has(id)) copy.delete(id)
      else copy.add(id)
      return copy
    })

  const stopSelecting = useCallback(() => {
    onSelecting(false)
    setPicked(new Set())
    setConfirming(false)
    setFailure(undefined)
  }, [onSelecting])

  // Folded or gone down while selecting: the selection goes with the part, or it would come back as
  // "0 selected" the next time this host is shown.
  const leave = useRef(onSelecting)
  leave.current = onSelecting
  useEffect(() => () => leave.current(false), [])

  // Another host began selecting: what was picked here goes, since a selection never mixes hosts.
  useEffect(() => {
    if (selecting) return
    setPicked(new Set())
    setConfirming(false)
  }, [selecting])

  useEffect(() => {
    if (!selecting) return undefined
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') stopSelecting()
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [selecting, stopSelecting])

  const archiveOne = async (entry: Entry) => {
    try {
      await api.post(`sessions/${entry.id}/archive`, { archived: true })
      reload()
    } catch (cause: unknown) {
      setFailure(messageOf(cause))
    }
  }

  /** Runs on the picked ids; `work` returns the ids it could not change. */
  const onMany = async (work: (ids: readonly string[]) => Promise<readonly string[]>) => {
    setBusy(true)
    setFailure(undefined)
    try {
      const refused = await work([...picked])
      if (refused.length > 0) setFailure(`${refused.length} could not be changed: a running conversation is left as it is.`)
      else stopSelecting()
      reload()
    } catch (cause: unknown) {
      setFailure(messageOf(cause))
    } finally {
      setBusy(false)
      setConfirming(false)
    }
  }

  const archiveMany = async (ids: readonly string[]) => {
    const tried = await Promise.all(ids.map((id) => api.post(`sessions/${id}/archive`, { archived: true }).then(() => undefined, () => id)))
    return tried.filter((id): id is string => id !== undefined)
  }

  const deleteMany = async (ids: readonly string[]) => {
    const done = await api.post<{ results: readonly { id: string; outcome: string }[] }>('sessions/remove', { ids })
    return done.results.filter((r) => r.outcome !== 'removed').map((r) => r.id)
  }

  const arrangeProps: Arrange = {
    canMove: !searching && !selecting && page?.registryError === undefined,
    mark: (id) => (dragging?.kind === 'project' && dragging.drop?.kind !== 'into' && dragging.drop?.id === id ? dragging.drop.kind : undefined),
    dragged: (id) => dragging?.kind === 'project' && dragging.id === id,
    start: (id, event) => start('project', id, event),
    step: (id, delta) => change(stepProject(layout, id, delta)),
    menu: (id, label, at) => setLayoutMenu({ at, items: projectMenu(id, label) }),
  }

  const projectMenu = (id: string, label: string): readonly MenuChoice[] => [
    { icon: 'arrow-up', label: 'Move up', disabled: !arrangeProps.canMove, choose: () => change(stepProject(layout, id, -1)) },
    { icon: 'arrow-down', label: 'Move down', disabled: !arrangeProps.canMove, choose: () => change(stepProject(layout, id, 1)) },
    { icon: 'folder-simple', label: 'Move to category…', disabled: !arrangeProps.canMove, choose: () => setArranging({ kind: 'move', project: id, label }) },
    { icon: 'folder-simple-plus', label: 'New category…', disabled: !arrangeProps.canMove, choose: () => setArranging({ kind: 'new', project: id }) },
  ]

  const categoryMenu = (category: CategoryEntry): readonly MenuChoice[] => [
    { icon: 'pencil-simple', label: 'Rename', disabled: false, choose: () => setArranging({ kind: 'rename', category }) },
    { icon: 'arrow-up', label: 'Move up', disabled: !arrangeProps.canMove, choose: () => change(stepCategory(layout, category.id, -1)) },
    { icon: 'arrow-down', label: 'Move down', disabled: !arrangeProps.canMove, choose: () => change(stepCategory(layout, category.id, 1)) },
    { icon: 'trash', label: 'Delete category', danger: true, disabled: false, choose: () => setArranging({ kind: 'delete', category }) },
  ]

  /** Where a dragged thing lands, said on the category it lands on or next to. */
  const categoryMark = (id: string): DropMark => {
    if (dragging?.kind === 'project') return dragging.drop?.kind === 'into' && dragging.drop.category === id ? 'into' : undefined
    if (dragging?.kind !== 'category' || dragging.index === undefined || dragging.id === id) return undefined
    const others = layout.categories.filter((c) => c.id !== dragging.id)
    if (others[dragging.index]?.id === id) return 'before'
    return dragging.index === others.length && others[others.length - 1]?.id === id ? 'after' : undefined
  }

  const project = (group: Group, inFolded: boolean) =>
    group.project === undefined ? null : (
      <Project
        key={group.key}
        group={group}
        // A search shows every match: a folded project would hide the very thing looked for.
        folded={inFolded || (!searching && folded.has(group.project.id))}
        onToggle={toggle}
        rows={rows}
        onMore={(id) => void showMore(id)}
        arrange={arrangeProps}
      />
    )

  const rows: RowState = { rest, now: Date.now(), selecting, picked, onPick, navigate, onMenu: (entry, at) => setMenu({ entry, at }) }

  return (
    <div class="s-host-body" ref={root}>
      {selecting ? (
        <div class="s-drawer-tools" role="toolbar" aria-label="Selected conversations">
          <button type="button" class="icon-btn" aria-label="Done selecting" onClick={stopSelecting}>
            <Icon name="x" size={16} />
          </button>
          <span class="s-count-picked num">{picked.size} selected</span>
          <button type="button" class="icon-btn" aria-label="Archive selected" title="Archive" disabled={busy || picked.size === 0} onClick={() => void onMany(archiveMany)}>
            <Icon name="archive" size={18} />
          </button>
          <button type="button" class="icon-btn s-danger" aria-label="Delete selected" title="Delete" disabled={busy || picked.size === 0} onClick={() => setConfirming(true)}>
            <Icon name="trash" size={18} />
          </button>
        </div>
      ) : null}
      {failure === undefined ? null : (
        <p class="s-error" role="alert">
          {failure}
        </p>
      )}
      {grants.length === 0 || searching ? null : (
        <section>
          <h2 class="s-sect">Folders waiting</h2>
          {grants.map((grant) => (
            <button type="button" key={grant.tag} class="s-item s-asking" onClick={() => navigate('projects')}>
              <span class="s-g s-g-ask">
                <Icon name="hand" size={18} />
              </span>
              <span class="s-item-text">
                <b>{grant.name ?? 'A new folder'}</b>
                <small>Waiting for approval</small>
              </span>
            </button>
          ))}
        </section>
      )}
      {layoutFailure === undefined ? null : (
        <p class="s-error" role="alert">
          {layoutFailure}
        </p>
      )}
      {blocks.map((block) => {
        if (block.kind === 'category') {
          const { category } = block
          // Folded, it keeps only the project whose conversation is open: where you are never goes.
          const shut = !searching && categoriesFolded.folded.has(category.id)
          const shown = shut ? block.groups.filter((group) => group.entries.some((entry) => entry.id === rest)) : block.groups
          return (
            <CategoryBlock
              key={`category:${category.id}`}
              category={category}
              count={layout.order.filter((placed) => placed.category === category.id).length}
              folded={shut}
              mark={categoryMark(category.id)}
              dragged={dragging?.kind === 'category' && dragging.id === category.id}
              canMove={arrangeProps.canMove}
              onToggle={() => categoriesFolded.toggle(category.id)}
              onMenu={(at) => setLayoutMenu({ at, items: categoryMenu(category) })}
              onStart={(event) => start('category', category.id, event)}
              onStep={(delta) => change(stepCategory(layout, category.id, delta))}
            >
              {shown.map((group) => project(group, shut))}
            </CategoryBlock>
          )
        }
        const { group } = block
        return group.project === undefined ? (
          <section key={group.key}>
            <h2 class="s-sect">{group.label}</h2>
            {group.entries.map((entry) => (
              <Row key={entry.id} entry={entry} compact={false} rows={rows} />
            ))}
          </section>
        ) : (
          project(group, false)
        )
      })}
      {dragging?.kind === 'project' && layout.categories.length > 0 ? (
        // Under everything while a project is dragged: the way out of every category at once.
        <div class={`s-drop-loose${dragging.drop?.kind === 'into' && dragging.drop.category === undefined ? ' s-drop-into' : ''}`} data-target="loose">
          No category
        </div>
      ) : null}
      {page !== undefined && projects.length === 0 && !searching ? (
        <p class="s-none">
          No projects yet.{' '}
          <button type="button" class="s-link" onClick={() => navigate('projects')}>
            Add one
          </button>
        </p>
      ) : null}
      {searching ? (
        <SearchResults
          api={api}
          query={query}
          shown={new Set(groups.flatMap((g) => g.entries.map((e) => e.id)))}
          labelOf={labelOf}
          colorOf={colorOf}
          rest={rest}
          navigate={navigate}
        />
      ) : null}
      {menu === undefined ? null : (
        <ContextMenu at={menu.at} onClose={closeMenu}>
          <MenuItem
            icon="check-square"
            label="Select"
            disabled={menu.entry.state === 'running'}
            onChoose={() => {
              onSelecting(true)
              setPicked(new Set([menu.entry.id]))
            }}
          />
          <MenuItem icon="pencil-simple" label="Rename" disabled={false} onChoose={() => setActing({ kind: 'rename', entry: menu.entry })} />
          <MenuItem icon="archive" label="Archive" disabled={menu.entry.state === 'running'} onChoose={() => void archiveOne(menu.entry)} />
          <MenuItem icon="trash" label="Delete" danger disabled={menu.entry.state === 'running'} onChoose={() => setActing({ kind: 'delete', entry: menu.entry })} />
        </ContextMenu>
      )}
      {layoutMenu === undefined ? null : (
        <ContextMenu at={layoutMenu.at} onClose={closeLayoutMenu}>
          {layoutMenu.items.map((item) => (
            <MenuItem key={item.label} icon={item.icon} label={item.label} danger={item.danger ?? false} disabled={item.disabled} onChoose={item.choose} />
          ))}
        </ContextMenu>
      )}
      {arranging === undefined ? null : <ArrangeSheet arranging={arranging} layout={layout} change={change} onSwitch={setArranging} onClose={closeArranging} />}
      {acting === undefined ? null : (
        <ConversationSheet
          api={api}
          target={{ id: acting.entry.id, title: acting.entry.title, project: acting.entry.siteLabel, manualTitle: acting.entry.manualTitle }}
          kind={acting.kind}
          onClose={() => setActing(undefined)}
          onDone={() => {
            reload()
            if (acting.kind === 'delete' && rest === acting.entry.id) navigate('new')
          }}
        />
      )}
      {confirming ? (
        <ConfirmSheet
          title={`Delete ${picked.size} conversation${picked.size === 1 ? '' : 's'}?`}
          body="Their logs are deleted for good. The files the agents changed stay as they are."
          action="Delete"
          busy={busy}
          error={undefined}
          onClose={() => setConfirming(false)}
          onConfirm={() => void onMany(deleteMany)}
        />
      ) : null}
    </div>
  )
}

/**
 * One conversation. COMPACT under its project — its title, its date, and a mark only when it failed —
 * unless it waits on the owner, runs, or the drawer is selecting: then the full row, with its glyph
 * or its checkbox.
 */
function Row({ entry, compact, rows }: { readonly entry: Entry; readonly compact: boolean; readonly rows: RowState }) {
  const asking = entry.detail !== undefined
  const picked = rows.picked.has(entry.id)
  const press = useLongPress((at) => rows.onMenu(entry, at))
  const onClick = () => {
    if (press.swallow()) return
    if (rows.selecting) {
      // A running conversation cannot be archived or deleted: it is not offered for choosing either.
      if (entry.state !== 'running') rows.onPick(entry.id)
      return
    }
    rows.navigate(entry.id)
  }
  const handlers = {
    onClick,
    onContextMenu: press.onContextMenu,
    onPointerDown: press.onPointerDown,
    onPointerMove: press.onPointerMove,
    onPointerUp: press.onPointerUp,
    onPointerCancel: press.onPointerCancel,
  }
  if (compact && !asking && entry.state !== 'running') {
    return (
      <button
        type="button"
        class={rows.selecting ? 's-conv s-conv-picking' : 's-conv'}
        aria-current={rows.rest === entry.id && !rows.selecting ? 'page' : undefined}
        aria-pressed={rows.selecting ? picked : undefined}
        {...handlers}
      >
        {rows.selecting ? (
          <span class={picked ? 's-pickbox s-g-picked' : 's-pickbox s-g-pick'}>
            <Icon name={picked ? 'check-square' : 'square'} size={16} />
          </span>
        ) : null}
        <span class="s-conv-title">{entry.title}</span>
        {entry.state === 'failed' ? <Icon name="x-circle" size={14} /> : null}
        {entry.touchedAt === undefined ? null : <span class="s-conv-date num">{day(entry.touchedAt, rows.now)}</span>}
      </button>
    )
  }
  // The last interaction, the key the list is sorted by — not the start, which would read as unsorted.
  const when = entry.touchedAt === undefined ? '' : ago(entry.touchedAt, rows.now)
  return (
    <button
      type="button"
      class={`s-item ${toneClass(entry.site, entry.color)}${asking ? ' s-asking' : ''}`}
      aria-current={rows.rest === entry.id && !rows.selecting ? 'page' : undefined}
      aria-pressed={rows.selecting ? picked : undefined}
      {...handlers}
    >
      <span class={`s-g ${rows.selecting ? (picked ? 's-g-picked' : 's-g-pick') : `s-g-${asking ? 'ask' : entry.state}`}`}>
        <Icon name={rows.selecting ? (picked ? 'check-square' : 'square') : asking ? 'hand' : GLYPH[entry.state]} size={18} />
      </span>
      <span class="s-item-text">
        <b>{entry.title}</b>
        <small class={asking ? 'mono' : undefined}>{`${entry.siteLabel} · ${asking ? entry.detail : when}`}</small>
      </span>
    </button>
  )
}

/**
 * One project, the way a chat app lists them: its folder in its colour and its name, a tap to fold
 * it, its conversations, and "Show more" while there are more. Folded, it keeps only the one open on
 * screen. Missing, it says so and lists nothing: its conversations are not read (criterion 25).
 */
function Project({
  group,
  folded,
  onToggle,
  rows,
  onMore,
  arrange,
}: {
  readonly group: Group
  readonly folded: boolean
  readonly onToggle: (id: string) => void
  readonly rows: RowState
  readonly onMore: (id: string) => void
  readonly arrange: Arrange
}) {
  const id = group.project?.id ?? group.label
  const missing = group.project?.status === 'missing'
  const press = useLongPress((at) => arrange.menu(id, group.label, at))
  return (
    <section
      class={`s-project ${toneClass(id, group.project?.color)}${arrange.dragged(id) ? ' s-dragging' : ''}${markClass(arrange.mark(id))}`}
      data-target="project"
      data-id={id}
    >
      <div class="s-project-row">
        <button
          type="button"
          class="s-project-head"
          aria-expanded={!folded}
          onClick={() => {
            if (!press.swallow()) onToggle(id)
          }}
          onContextMenu={press.onContextMenu}
          onPointerDown={press.onPointerDown}
          onPointerMove={press.onPointerMove}
          onPointerUp={press.onPointerUp}
          onPointerCancel={press.onPointerCancel}
        >
          <Icon name={missing ? 'warning' : 'folder-simple'} size={18} />
          <span class="s-project-name">{group.label}</span>
          <Icon name={folded ? 'caret-right' : 'caret-down'} size={12} />
        </button>
        {arrange.canMove ? <Grip label={group.label} onStart={(event) => arrange.start(id, event)} onStep={(delta) => arrange.step(id, delta)} /> : null}
      </div>
      {missing && !folded ? <p class="s-missing s-indent">Folder missing</p> : null}
      {/* Folded, it still shows the conversation that is open: where you are never disappears. */}
      {(folded ? group.entries.filter((entry) => entry.id === rows.rest) : group.entries).map((entry) => (
        <Row key={entry.id} entry={entry} compact rows={rows} />
      ))}
      {!folded && group.project?.hasMore === true ? (
        <button type="button" class="s-more" onClick={() => onMore(id)}>
          Show more
        </button>
      ) : null}
    </section>
  )
}

/**
 * Which projects — or categories — the owner folded, by id, remembered on this device under `key`.
 * Storage off: they start open.
 */
export function useFolded(key: string): { readonly folded: ReadonlySet<string>; readonly toggle: (id: string) => void } {
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => readFolded(key))
  const toggle = (id: string) => {
    const next = new Set(folded)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setFolded(next)
    writeFolded(key, next)
  }
  return { folded, toggle }
}

function readFolded(key: string): ReadonlySet<string> {
  try {
    const stored: unknown = JSON.parse(window.localStorage.getItem(key) ?? '[]')
    return new Set(Array.isArray(stored) ? stored.filter((id): id is string => typeof id === 'string') : [])
  } catch {
    return new Set()
  }
}

function writeFolded(key: string, folded: ReadonlySet<string>): void {
  try {
    window.localStorage.setItem(key, JSON.stringify([...folded]))
  } catch {
    // Not remembered; it still folds for this visit.
  }
}

/**
 * The sheets arranging opens. Each applies its change AT ONCE and closes: the layout is optimistic,
 * and a failure is said in the drawer, where the change would have shown.
 */
function ArrangeSheet({
  arranging,
  layout,
  change,
  onSwitch,
  onClose,
}: {
  readonly arranging: Arranging
  readonly layout: Layout
  readonly change: (next: Layout) => void
  /** From one sheet to the next: "Move to…" becomes "New category" for the same project. */
  readonly onSwitch: (next: Arranging) => void
  readonly onClose: () => void
}) {
  switch (arranging.kind) {
    case 'new':
      return (
        <CategoryNameSheet
          title="New category"
          initial=""
          action="Create"
          onClose={onClose}
          onSave={(name) => change(addCategory(layout, { id: newCategoryId(layout.categories), name }, arranging.project))}
        />
      )
    case 'rename':
      return (
        <CategoryNameSheet
          title="Rename category"
          initial={arranging.category.name}
          action="Save"
          onClose={onClose}
          onSave={(name) => change(renameCategory(layout, arranging.category.id, name))}
        />
      )
    case 'delete':
      return (
        <ConfirmSheet
          title={`Delete ${arranging.category.name}?`}
          body="Its projects stay, with no category. Nothing else changes."
          action="Delete category"
          busy={false}
          error={undefined}
          onClose={onClose}
          onConfirm={() => {
            change(removeCategory(layout, arranging.category.id))
            onClose()
          }}
        />
      )
    case 'move':
      return (
        <MoveToCategorySheet
          project={arranging.label}
          categories={layout.categories}
          current={layout.order.find((placed) => placed.id === arranging.project)?.category}
          onClose={onClose}
          onPick={(category) => change(moveProject(layout, arranging.project, { category, index: Number.MAX_SAFE_INTEGER }))}
          onNew={() => onSwitch({ kind: 'new', project: arranging.project })}
        />
      )
  }
}

/** The first pending per session, with the site and what it asks for as the notice carried them. */
function waitingOf(pending: readonly Pending[]): Waiting {
  const waiting = new Map<string, { site: string | undefined; detail: string }>()
  for (const p of pending) {
    const id = sessionOf(p)
    if (id === undefined || waiting.has(id)) continue
    const text = (key: string) => (typeof p.data[key] === 'string' ? (p.data[key] as string) : undefined)
    // A batch of questions says how many (spec 2026-10-01-preguntas-con-opciones, D10); an ask, what it touches.
    const questions = questionsOf(p)
    const detail = questions === undefined ? [text('toolName'), text('file')].filter(Boolean).join(' ') : questionsLabel(questions.count)
    waiting.set(id, { site: text('siteId'), detail: detail || 'Waiting for you' })
  }
  return waiting
}
