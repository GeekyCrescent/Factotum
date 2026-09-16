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
import { chmod, mkdir } from 'node:fs/promises'
import { DEFAULT_ENVIRONMENT, isEnvironment, type Environment } from '@factotum/core'

export interface StatePaths {
  readonly root: string
  readonly config: string
  /** `<root>/modules/`; each module gets `<root>/modules/<id>/`. */
  readonly modules: string
  /**
   * `<root>/push/`: the VAPID pair and the subscriptions.
   *
   * THE DAEMON'S, NOT A MODULE'S. The keys identify the daemon as a sender — a module is not
   * a sender — and `ModuleContext` promises a module sees no path outside its own
   * `stateDir`, so a key the kernel also reads cannot live under `modules/`.
   */
  readonly push: string
}

export function statePaths(env: Environment, home: string = homedir()): StatePaths {
  const root = join(home, '.factotum', env)
  return {
    root,
    config: join(root, 'config.json'),
    modules: join(root, 'modules'),
    push: join(root, 'push'),
  }
}

export function moduleStateDir(paths: StatePaths, id: string): string {
  return join(paths.modules, id)
}

/** Idempotent; called at boot so the first write is not the first failure. */
export async function ensureStateRoots(paths: StatePaths): Promise<void> {
  await mkdir(paths.modules, { recursive: true })
  await mkdir(paths.push, { recursive: true, mode: PUSH_DIR_MODE })
  // `mode` on mkdir is masked by the umask AND ignored when the directory already exists,
  // so neither is a guarantee. The chmod is. It is not a defence against the agent — an
  // agent runs as the owner and reads what the owner reads (spec §0.29) — it is so that
  // nobody ELSE on the machine does.
  await chmod(paths.push, PUSH_DIR_MODE)
}

/** Owner-only. The keys and the subscription endpoints are both capabilities. */
const PUSH_DIR_MODE = 0o700

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
