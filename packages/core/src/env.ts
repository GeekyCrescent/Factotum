/** The two environments. Both can run at once on one machine, on different ports. */

export const ENVIRONMENTS = ['dev', 'prod'] as const

export type Environment = (typeof ENVIRONMENTS)[number]

/** `prod` is what someone who clones and runs `factotum start` expects. */
export const DEFAULT_ENVIRONMENT: Environment = 'prod'

export function isEnvironment(value: unknown): value is Environment {
  return typeof value === 'string' && (ENVIRONMENTS as readonly string[]).includes(value)
}
