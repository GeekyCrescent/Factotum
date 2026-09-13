/**
 * Reading the config, and turning a module list plus a config blob into the set of
 * modules that will actually run.
 *
 * This is where abort-versus-degrade is decided in practice. See `errors.ts` for the
 * rule; the short version is that a duplicate id is a programming error and aborts,
 * while a module whose fragment does not validate is disabled with a reason and the
 * daemon carries on.
 */

import { readFile } from 'node:fs/promises'
import {
  moduleIdSchema,
  rootConfigSchema,
  type AnyModule,
  type Environment,
  type ModuleStatus,
  type RootConfig,
} from '@factotum/core'
import { BootError } from '../errors.ts'
import type { StatePaths } from './paths.ts'

export async function loadRootConfig(
  env: Environment,
  paths: StatePaths,
): Promise<RootConfig> {
  let text: string
  try {
    text = await readFile(paths.config, 'utf8')
  } catch {
    throw new BootError(
      'config-unreadable',
      `no config at ${paths.config}`,
      `run \`factotum init --env ${env}\``,
    )
  }

  let json: unknown
  try {
    json = JSON.parse(text)
  } catch (error) {
    throw new BootError(
      'config-invalid',
      `${paths.config} is not valid JSON: ${(error as Error).message}`,
      'fix the syntax, or delete the file and run `factotum init`',
    )
  }

  const parsed = rootConfigSchema.safeParse(json)
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    const where = first?.path.join('.') || '(root)'
    throw new BootError(
      'config-invalid',
      `${paths.config}: \`${where}\` ${first?.message ?? 'is invalid'}`,
      'see config.template.json for the expected shape',
    )
  }

  // The cross-check that costs three lines and saves an afternoon: copying
  // prod/config.json into dev/ otherwise starts a dev that believes it is prod, on
  // prod's port, and the failure surfaces as an EADDRINUSE that explains nothing.
  if (parsed.data.environment !== env) {
    throw new BootError(
      'environment-mismatch',
      `${paths.config} declares environment "${parsed.data.environment}" ` +
        `but this process resolved "${env}"`,
      `either fix \`environment\` in that file, or start with --env ${parsed.data.environment}`,
    )
  }

  return parsed.data
}

export interface ComposedModule {
  readonly module: AnyModule
  readonly status: ModuleStatus
  /** The parsed fragment. Only meaningful when `status.kind === 'enabled'`. */
  readonly config: unknown
}

/**
 * Which modules run, with what configuration.
 *
 * A module that is OFF is not the same as one that is DISABLED. Off was never
 * loaded: no config is asked for, no routes are registered, it does not appear.
 * Disabled was attempted and left a reason: it appears in `GET /modules`, its routes
 * answer 501 with that reason, and `doctor` can say so.
 */
export function composeModules(
  modules: readonly AnyModule[],
  raw: RootConfig['modules'],
): readonly ComposedModule[] {
  const seen = new Set<string>()

  for (const module of modules) {
    if (!moduleIdSchema.safeParse(module.id).success) {
      throw new BootError(
        'module-id-invalid',
        `module id ${JSON.stringify(module.id)} must match /^[a-z][a-z0-9-]*$/`,
        'an id names a directory and a URL prefix, so it cannot contain "/" or ".."',
      )
    }
    if (seen.has(module.id)) {
      throw new BootError(
        'module-id-duplicate',
        `two modules claim the id "${module.id}"`,
        'rename one of them in modules/index.ts or modules/local.ts',
      )
    }
    seen.add(module.id)
  }

  const composed: ComposedModule[] = []

  for (const module of modules) {
    const entry = raw[module.id]
    if (entry?.enabled !== true) continue

    if (module.configSchema === undefined) {
      composed.push({ module, status: { kind: 'enabled' }, config: undefined })
      continue
    }

    const { enabled: _enabled, ...fragment } = entry
    const parsed = module.configSchema.safeParse(fragment)
    if (!parsed.success) {
      const first = parsed.error.issues[0]
      const where = first?.path.join('.') || '(fragment)'
      composed.push({
        module,
        status: {
          kind: 'disabled',
          reason: `config \`modules.${module.id}.${where}\`: ${first?.message ?? 'is invalid'}`,
        },
        config: undefined,
      })
      continue
    }

    composed.push({ module, status: { kind: 'enabled' }, config: parsed.data })
  }

  return composed
}
