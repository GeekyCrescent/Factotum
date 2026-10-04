/**
 * `GET /skills?site=<id>` (spec 2026-10-03-skills-a-mano, D6).
 *
 * ALWAYS 200 once the module is up. A missing, oversized or malformed note, an unknown site and a list the
 * CLI has not announced yet are all things the body SAYS (`notes.state`, `list.state`), never a status:
 * the box of a conversation must not break because of a file the owner is editing.
 *
 * Declared here, with its dependencies handed in, like `dictation/routes.ts`: this folder imports nothing
 * from `../server.ts` (D1).
 */

import type { ModuleResponse, RouteTable } from '@factotum/core'
import type { Announced } from '../types.ts'
import { arrange } from './arrange.ts'
import type { NotesRead } from './notes.ts'

const NO_STORE = { 'cache-control': 'no-store' } as const

const STARTING: ModuleResponse = { status: 503, body: { error: { code: 'starting', message: 'skills are not ready yet' } } }

/** What the route needs, and nothing else: the engine's two reads and the note. */
export interface SkillsDeps {
  readonly announced: () => Announced | undefined
  readonly pinnedOf: (siteId: string) => readonly string[]
  readonly notes: { readonly read: () => Promise<NotesRead> }
}

/** `get` is read on every request: `start()` fills what it returns after these routes were composed at step 8. */
export function skillsRoutes(get: () => SkillsDeps | undefined): RouteTable {
  return {
    'GET /skills': async (req) => {
      const deps = get()
      if (deps === undefined) return STARTING
      const site = req.query['site']
      const view = arrange({
        announced: deps.announced(),
        notes: await deps.notes.read(),
        pinned: site === undefined || site === '' ? [] : deps.pinnedOf(site),
      })
      return { status: 200, headers: NO_STORE, body: view }
    },
  }
}
