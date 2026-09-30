/**
 * A `RegistryStore` in memory, FOR TESTS: the real one is the module's (`modules/sessions/
 * registry.ts`), and a test of this package may not import a module (CLAUDE.md §7). Not exported
 * from `index.ts`.
 *
 * Same contract as the real one where it matters to the engine: `decide` runs inside a queue with
 * the current view, memory changes only after the "write", a failed write leaves it as it was and
 * does not poison the next one, and `broken` never writes.
 */

import type { RegistryEdit, RegistryStore, RegistryUpdate, RegistryView, SiteConfig } from './types.ts'

export interface MemoryRegistry extends RegistryStore {
  /** What the store holds now. */
  readonly current: () => RegistryView
  /** The next write fails with this reason. */
  readonly failNextWrite: (reason: string) => void
  /** How many writes succeeded. */
  readonly writes: () => number
}

const ID = /^[a-z0-9][a-z0-9-]*$/

export function memoryRegistry(
  initial: { readonly sites?: readonly SiteConfig[]; readonly sharedPaths?: readonly string[] } = {},
  options: { readonly broken?: string } = {},
): MemoryRegistry {
  let view: RegistryView = {
    projects: (initial.sites ?? []).map((site) => ({ id: site.id, path: site.path })),
    shared: (initial.sharedPaths ?? []).map((path) => ({ path })),
    categories: [],
  }
  let failure: string | undefined
  let writes = 0
  let chain: Promise<unknown> = Promise.resolve()

  const update: RegistryStore['update'] = (decide) => {
    const work = async (): Promise<RegistryUpdate> => {
      if (options.broken !== undefined) return { kind: 'broken', reason: options.broken }
      const decided = await decide(view)
      if ('refused' in decided) return { kind: 'refused', reason: decided.refused }
      if (failure !== undefined) {
        const reason = failure
        failure = undefined
        return { kind: 'failed', reason }
      }
      view = apply(view, decided)
      writes += 1
      return { kind: 'ok', registry: view }
    }
    const next = chain.then(work, work)
    chain = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  return {
    file: '/memory/projects.json',
    load: async () =>
      options.broken !== undefined ? { kind: 'broken', reason: options.broken } : { kind: 'ok', registry: view, warnings: [], skipped: [] },
    update,
    deriveId: (name) => {
      const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
      return ID.test(id) ? id : undefined
    },
    isValidId: (id) => ID.test(id),
    current: () => view,
    failNextWrite: (reason) => {
      failure = reason
    },
    writes: () => writes,
  }
}

function apply(view: RegistryView, edit: RegistryEdit): RegistryView {
  switch (edit.kind) {
    case 'add-project':
      return { ...view, projects: [...view.projects, { id: edit.id, path: edit.path, name: edit.name, color: edit.color }] }
    case 'set-project':
      return { ...view, projects: view.projects.map((p) => (p.id === edit.id ? { ...p, name: edit.name, color: edit.color } : p)) }
    case 'remove-project':
      return { ...view, projects: view.projects.filter((p) => p.id !== edit.id) }
    case 'add-shared':
      return { ...view, shared: [...view.shared, { path: edit.path }] }
    case 'remove-shared':
      return { ...view, shared: view.shared.filter((s) => s.path !== edit.path) }
    case 'set-layout': {
      // Trusts the engine's check: the real store's own last line is tested in the module.
      const byId = new Map(view.projects.map((p) => [p.id, p]))
      const projects = edit.layout.order.flatMap((placed) => {
        const found = byId.get(placed.id)
        return found === undefined ? [] : [{ ...found, category: placed.category }]
      })
      return { ...view, projects, categories: edit.layout.categories }
    }
  }
}
