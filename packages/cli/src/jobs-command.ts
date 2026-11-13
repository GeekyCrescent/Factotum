/**
 * `factotum jobs test-application` — the test application, from the terminal (spec
 * 2026-11-12-postulaciones, design D3 «La postulación de prueba»; tasks C3).
 *
 * Before the first real email to a company, the owner sends one to his own address. That has no HTTP
 * route on purpose: this opens `<stateDir>/jobs.db` beside the daemon and calls the engine's plain
 * functions over the store — `createTestApplication`, `closeApplication` — and NEVER `createJobs`
 * nor `start`. From a second process, the startup write (`sending → send-unknown`…) would mark the
 * daemon's send in flight as doubtful; `openDb` only opens, migrates and checks.
 *
 * The CV is only queued here: the daemon's pump picks it up on its next tick.
 */

import { moduleStateDir, statePaths } from '@factotum/kernel'
import type { Environment } from '@factotum/core'
import { closeApplication, createTestApplication, openDb, type Db } from '@factotum/jobs'

export interface JobsCommandDeps {
  readonly env: Environment
  /** Without `--env`: `main` strips it first. */
  readonly argv: readonly string[]
  readonly home?: string
  readonly out?: (line: string) => void
  readonly now?: () => Date
}

const USAGE = [
  'usage: factotum jobs test-application --to <address> [--env dev|prod]',
  '       factotum jobs test-application --close <id> --reason <text> [--env dev|prod]',
  '',
  '  --to     create the test application to that address (one at a time); its CV is queued',
  '           and the daemon generates it on its next tick.',
  '  --close  close it (or any application not yet being sent), with your reason.',
]

type Action = { readonly kind: 'create'; readonly to: string } | { readonly kind: 'close'; readonly id: string; readonly reason: string }

/** The value after `flag`, `null` when the flag is absent, `undefined` when it has no value. */
function valueOf(argv: readonly string[], flag: string): string | null | undefined {
  const at = argv.indexOf(flag)
  if (at === -1) return null
  const value = argv[at + 1]
  return value === undefined || value.startsWith('--') ? undefined : value
}

function parse(argv: readonly string[]): Action | undefined {
  const [sub, ...rest] = argv
  if (sub !== 'test-application') return undefined
  const to = valueOf(rest, '--to')
  const id = valueOf(rest, '--close')
  const reason = valueOf(rest, '--reason')
  if (to === undefined || id === undefined || reason === undefined) return undefined
  if (to !== null) return id === null && reason === null ? { kind: 'create', to } : undefined
  if (id !== null && reason !== null) return { kind: 'close', id, reason }
  return undefined
}

function run(db: Db, action: Action, now: () => Date, out: (line: string) => void): number {
  if (action.kind === 'create') {
    const created = createTestApplication(db, { now }, { to: action.to })
    if (!created.ok) {
      out(`jobs: ${created.error.reason}`)
      return 1
    }
    out(`test application ${created.value.id} created (${created.value.state}); its CV is queued for the daemon.`)
    out(`close it when done: factotum jobs test-application --close ${created.value.id} --reason "<text>"`)
    return 0
  }
  const closed = closeApplication(db, { now }, action.id, { reason: action.reason })
  if (!closed.ok) {
    out(`jobs: ${closed.error.reason}`)
    return 1
  }
  out(`application ${closed.value.id} closed.`)
  return 0
}

export async function jobsCommand(deps: JobsCommandDeps): Promise<number> {
  const out = deps.out ?? ((line: string) => console.log(line))
  const now = deps.now ?? (() => new Date())
  const action = parse(deps.argv)
  if (action === undefined) {
    for (const line of USAGE) out(line)
    return 2
  }

  const dir = moduleStateDir(statePaths(deps.env, deps.home), 'jobs')
  const opened = await openDb({ dir, now })
  if (!opened.ok) {
    out(`jobs: cannot open the store: ${opened.error.reason}`)
    return 1
  }
  try {
    return run(opened.value, action, now, out)
  } finally {
    opened.value.close()
  }
}
