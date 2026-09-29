/**
 * What `factotum site` still decides about the config, as data.
 *
 * THE CLI NO LONGER EDITS PROJECTS (spec 2026-09-29, D1; ADR-0011). They live in the sessions
 * module's `projects.json`, and the daemon is its only writer: from the app, with an approval on
 * the phone, or — without a phone — by hand with the daemon stopped. The config's `sites` and
 * `sharedPaths` only seed that file the first time. What is left here is reading the config, and
 * switching the module on for an installation that never had it, which is still a config edit.
 *
 * Everything here is PURE and returns a NEW config: the disk, the prompt and the restart live in
 * `site-command.ts`. NOTHING LEAVES HERE THAT `factotum start` WOULD REFUSE: the edited config is
 * parsed back through the REAL schemas, module fragment included, exactly as `init` does.
 */

import { rootConfigSchema } from '@factotum/core'
import { sessionsConfigSchema } from '@factotum/modules'

const SESSIONS = 'sessions'

/** The default entry, so a module switched on can launch something. `init` writes it too. */
export const FREE_ENTRY = { id: 'free', label: 'Free prompt', invoke: { kind: 'none' } } as const

export type EditResult = { readonly ok: true; readonly config: unknown } | { readonly ok: false; readonly error: string }

interface SessionsFragment {
  readonly enabled?: boolean
  readonly sites?: readonly { readonly id: string; readonly path: string }[]
  readonly sharedPaths?: readonly string[]
  readonly catalog?: readonly unknown[]
}

export function listSites(config: unknown): {
  readonly sites: readonly { readonly id: string; readonly path: string }[]
  readonly sharedPaths: readonly string[]
} {
  const fragment = fragmentOf(config)
  return { sites: fragment.sites ?? [], sharedPaths: fragment.sharedPaths ?? [] }
}

/**
 * Where the module stands in the config. `off` is an `enabled: false` SOMEBODY WROTE: that is a
 * decision, and `site add` does not overrule it. `absent` is a fragment with no `enabled` at all —
 * which the kernel reads as off, and which is what an installation from before `init` switched the
 * module on looks like.
 */
export function sessionsState(config: unknown): 'on' | 'off' | 'absent' {
  const enabled = fragmentOf(config).enabled
  if (enabled === true) return 'on'
  return enabled === false ? 'off' : 'absent'
}

/**
 * Switched ON and given the free-prompt entry. A fragment with an empty catalog would start and be
 * able to launch nothing, which reads as broken. The sites already in the fragment stay: they seed
 * the registry at the next start.
 */
export function enableSessions(config: unknown): EditResult {
  const fragment = fragmentOf(config)
  return validated(config, {
    ...fragment,
    enabled: true,
    catalog: fragment.catalog === undefined || fragment.catalog.length === 0 ? [FREE_ENTRY] : fragment.catalog,
  })
}

function fragmentOf(config: unknown): SessionsFragment {
  const modules = (config as { modules?: Record<string, unknown> } | null)?.modules ?? {}
  const fragment = modules[SESSIONS]
  return typeof fragment === 'object' && fragment !== null ? (fragment as SessionsFragment) : {}
}

/** The whole config back through both schemas — the module's fragment included. */
function validated(config: unknown, fragment: SessionsFragment): EditResult {
  const next = {
    ...(config as Record<string, unknown>),
    modules: { ...((config as { modules?: Record<string, unknown> }).modules ?? {}), [SESSIONS]: fragment },
  }

  const root = rootConfigSchema.safeParse(next)
  if (!root.success) {
    const issue = root.error.issues[0]
    return { ok: false, error: `${issue?.path.join('.') ?? '?'}: ${issue?.message ?? 'invalid'}` }
  }

  // The root schema keeps a module's fragment as an opaque record — validating it is the module's
  // job, and `boot` does it at step 6. Doing it here too is what stops this command writing a file
  // that disables the very module it was switching on.
  const parsed = sessionsConfigSchema.safeParse(fragment)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    return { ok: false, error: `sessions.${issue?.path.join('.') ?? '?'}: ${issue?.message ?? 'invalid'}` }
  }

  return { ok: true, config: next }
}
