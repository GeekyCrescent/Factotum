/**
 * Where state lives, per environment.
 *
 * `dev` and `prod` are two roots under one home directory, which is what lets both
 * run at once on the same machine with different module sets — the whole point of
 * having environments here.
 *
 * `home` is injectable because otherwise every test writes into the real `~`.
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { DEFAULT_ENVIRONMENT, isEnvironment, type Environment } from '@factotum/core'

export interface StatePaths {
  readonly root: string
  readonly config: string
  /** `<root>/modules/`; each module gets `<root>/modules/<id>/`. */
  readonly modules: string
}

export function statePaths(env: Environment, home: string = homedir()): StatePaths {
  const root = join(home, '.factotum', env)
  return {
    root,
    config: join(root, 'config.json'),
    modules: join(root, 'modules'),
  }
}

export function moduleStateDir(paths: StatePaths, id: string): string {
  return join(paths.modules, id)
}

/** Idempotent; called at boot so the first write is not the first failure. */
export async function ensureStateRoots(paths: StatePaths): Promise<void> {
  await mkdir(paths.modules, { recursive: true })
}

/**
 * `--env` beats `FACTOTUM_ENV` beats `prod`.
 *
 * `prod` is the default because someone who clones the project and runs
 * `factotum start` means production; `dev` is asked for explicitly.
 *
 * An unrecognised value is not silently ignored — it would send state to the wrong
 * root and the mistake would surface much later.
 */
export function resolveEnvironment(
  flag: string | undefined,
  envVar: string | undefined,
): Environment {
  const candidate = flag ?? envVar
  if (candidate === undefined) return DEFAULT_ENVIRONMENT
  if (!isEnvironment(candidate)) {
    const source = flag !== undefined ? '--env' : 'FACTOTUM_ENV'
    throw new Error(
      `${source}=${candidate} is not an environment (expected "dev" or "prod")`,
    )
  }
  return candidate
}
