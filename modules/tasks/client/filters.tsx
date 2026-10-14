/**
 * Filters by area, label and project, kept on this device (criterion 13). Redesign A gives them two
 * shapes, and neither is bigger than the board:
 *
 *  - DESKTOP: three quiet buttons in the toolbar, each a native `<select>` under its label — the
 *    platform's own menu, keyboard and screen reader included, and nothing clipped by the board's
 *    scroll. One that is on says what it holds («Area: 8780»).
 *  - PHONE: a funnel in the bar opens a sheet of buttons. A choice applies at once, and the button at
 *    the foot says how many cards are left before it closes the sheet.
 */

import type { BoardView } from '../types.ts'
import { ProjectTag } from './card.tsx'
import { Icon } from './icon.tsx'
import { filterCount, projectKey, projectOf, type Filter } from './model.ts'
import { Sheet } from './sheet.tsx'

type Key = keyof Filter

interface Choice {
  readonly value: string
  readonly label: string
}

/** A filter on something no card uses any more still shows, so it can be cleared. */
function withCurrent(values: readonly Choice[], current: string | undefined): readonly Choice[] {
  return current === undefined || values.some((v) => v.value === current) ? values : [...values, { value: current, label: current }]
}

function projectLabel(key: string): string {
  return key.startsWith('/') ? key.slice(1) : key.replace('/', ' · ')
}

function choicesOf(view: BoardView, filter: Filter): Readonly<Record<Key, readonly Choice[]>> {
  const plain = (values: readonly string[]): readonly Choice[] => values.map((value) => ({ value, label: value }))
  const projects = [...new Set(view.projects.map(projectKey))].map((key) => ({ value: key, label: projectLabel(key) }))
  return {
    area: withCurrent(plain(view.areas), filter.area),
    label: withCurrent(plain(view.labels), filter.label),
    project: withCurrent(projects, filter.project),
  }
}

const NAMES: readonly { readonly key: Key; readonly label: string }[] = [
  { key: 'area', label: 'Area' },
  { key: 'label', label: 'Label' },
  { key: 'project', label: 'Project' },
]

function changed(filter: Filter, key: Key, value: string | undefined): Filter {
  const { [key]: _dropped, ...rest } = filter
  return value === undefined || value === '' ? rest : { ...rest, [key]: value }
}

export function FilterMenus({ view, filter, setFilter }: { readonly view: BoardView; readonly filter: Filter; readonly setFilter: (next: Filter) => void }) {
  const choices = choicesOf(view, filter)
  return (
    <div class="t-filters" role="group" aria-label="Filter the board">
      <Icon name="funnel" size={16} class="dim-3" />
      {NAMES.map(({ key, label }) => {
        const current = filter[key]
        const shown = current === undefined ? label : `${label}: ${choices[key].find((c) => c.value === current)?.label ?? current}`
        return (
          <label key={key} class={current === undefined ? 't-filter' : 't-filter t-filter-on'}>
            <span aria-hidden="true">{shown}</span>
            <Icon name="caret-down" size={14} />
            <select aria-label={label} value={current ?? ''} onChange={(e) => setFilter(changed(filter, key, (e.target as HTMLSelectElement).value))}>
              <option value="">Any {label.toLowerCase()}</option>
              {choices[key].map((choice) => (
                <option key={choice.value} value={choice.value}>
                  {choice.label}
                </option>
              ))}
            </select>
          </label>
        )
      })}
      {filterCount(filter) > 0 ? (
        <button type="button" class="btn sm quiet" onClick={() => setFilter({})}>
          Clear
        </button>
      ) : null}
    </div>
  )
}

export function FilterSheet({
  view,
  filter,
  setFilter,
  shown,
  onClose,
}: {
  readonly view: BoardView
  readonly filter: Filter
  readonly setFilter: (next: Filter) => void
  /** How many cards the board shows with the filter as it is. */
  readonly shown: number
  readonly onClose: () => void
}) {
  const choices = choicesOf(view, filter)
  return (
    <Sheet
      id="t-filter-title"
      title="Filter"
      onClose={onClose}
      foot={
        <button type="button" class="btn decide primary t-grow" onClick={onClose}>
          {shown === 1 ? 'Show 1 card' : `Show ${shown} cards`}
        </button>
      }
    >
      {NAMES.map(({ key, label }) => (
        <section key={key} class="t-chooser">
          <h3>{label}</h3>
          {choices[key].length === 0 ? (
            <p class="dim-2">No card has one yet.</p>
          ) : (
            <div class="t-chips" role="group" aria-label={label}>
              {choices[key].map((choice) => {
                const on = filter[key] === choice.value
                return (
                  <button
                    key={choice.value}
                    type="button"
                    class="chip"
                    aria-pressed={on}
                    onClick={() => setFilter(changed(filter, key, on ? undefined : choice.value))}
                  >
                    {key === 'project' ? <ProjectTag siteId={projectOf(choice.value)?.siteId ?? choice.value} label={choice.label} /> : choice.label}
                  </button>
                )
              })}
            </div>
          )}
        </section>
      ))}
      <div class="t-chooser-foot">
        <p class="dim-2">Kept on this device only.</p>
        {filterCount(filter) > 0 ? (
          <button type="button" class="btn quiet" onClick={() => setFilter({})}>
            Clear all
          </button>
        ) : null}
      </div>
    </Sheet>
  )
}
