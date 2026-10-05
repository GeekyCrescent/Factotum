/**
 * `GET /skills?site=<id>` (spec 2026-10-03-skills-a-mano, D6).
 *
 * ALWAYS 200 once the module is up. A missing, oversized or malformed note, an unknown site and a list the
 * CLI has not announced yet are all things the body SAYS (`notes.state`, `list.state`), never a status:
 * the box of a conversation must not break because of a file the owner is editing.
 *
 * `GET /skills/usage?days=N` (D9) counts what was used. The ENGINE counts every announced name, built-in commands
 * included; THIS filters, because only here is the note known: skills, agents and the commands the note names,
 * so `clear` never shows up under "Never used".
 *
 * Declared here, with its dependencies handed in, like `dictation/routes.ts`: this folder imports nothing
 * from `../server.ts` (D1).
 */

import type { ModuleResponse, RouteTable } from '@factotum/core'
import type { Announced, UsageCount } from '../types.ts'
import { arrange } from './arrange.ts'
import type { NotesRead } from './notes.ts'

const NO_STORE = { 'cache-control': 'no-store' } as const

const STARTING: ModuleResponse = { status: 503, body: { error: { code: 'starting', message: 'skills are not ready yet' } } }

/** What the route needs, and nothing else: the engine's two reads and the note. */
export interface SkillsDeps {
  readonly announced: () => Announced | undefined
  readonly pinnedOf: (siteId: string) => readonly string[]
  readonly notes: { readonly read: () => Promise<NotesRead> }
  readonly usage: (days: number) => Promise<readonly UsageCount[] | undefined>
}

const DEFAULT_DAYS = 30
const MAX_DAYS = 90
const WHOLE_NUMBER = /^[0-9]+$/

/** `undefined` when `days` is present and not a whole number from 1 to 90. */
function daysOf(raw: string | undefined): number | undefined {
  if (raw === undefined) return DEFAULT_DAYS
  if (!WHOLE_NUMBER.test(raw)) return undefined
  const days = Number(raw)
  return days >= 1 && days <= MAX_DAYS ? days : undefined
}

const UNKNOWN = { list: { state: 'unknown' }, counts: [] } as const

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

    'GET /skills/usage': async (req) => {
      const deps = get()
      if (deps === undefined) return STARTING
      const days = daysOf(req.query['days'])
      if (days === undefined) {
        return { status: 400, headers: NO_STORE, body: { error: { code: 'invalid-request', message: `days must be a whole number from 1 to ${MAX_DAYS}` } } }
      }
      const list = deps.announced()
      const counts = list === undefined ? undefined : await deps.usage(days)
      if (list === undefined || counts === undefined) return { status: 200, headers: NO_STORE, body: UNKNOWN }

      // The commands the note names, and only those that resolve: the same reading as the list's.
      const view = arrange({ announced: list, notes: await deps.notes.read(), pinned: [] })
      const noted = view.groups.flatMap((group) => group.entries).filter((entry) => entry.kind === 'command').map((entry) => entry.name)
      const shown = new Set([...list.skills, ...list.agents, ...noted])
      return { status: 200, headers: NO_STORE, body: { list: view.list, counts: counts.filter((count) => shown.has(count.name)) } }
    },
  }
}
