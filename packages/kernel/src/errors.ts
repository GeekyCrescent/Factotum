/**
 * How the kernel refuses to start.
 *
 * `boot` NEVER calls `process.exit`. It throws, and `packages/cli` decides the exit
 * code. That is what lets every abort path be tested in-process instead of by
 * spawning a subprocess to read its status.
 *
 * The rule that decides abort-versus-degrade:
 *
 *   ABORT anything that compromises the NETWORK SURFACE or the IDENTITY of the
 *   process — where it listens, which environment it believes it is in, and whether
 *   two modules claim the same id.
 *
 *   DEGRADE anything confined to a SINGLE MODULE.
 *
 * Put the other way round: the daemon refuses to exist wrongly, but it does not
 * refuse to exist incompletely. A mistyped credential path for one module cannot
 * leave its owner with nothing.
 */

export type BootErrorCode =
  | 'config-unreadable'
  | 'config-invalid'
  | 'environment-mismatch'
  | 'listen-unresolvable'
  | 'listen-out-of-range'
  | 'module-id-invalid'
  | 'module-id-duplicate'
  | 'route-key-invalid'
  | 'port-in-use'
  | 'bind-mismatch'

/**
 * Every message must answer three questions: what was looked for, what was found,
 * and what to do about it. "Failed closed and I don't know why" is the most common
 * complaint about projects that get this right, so the remedy is part of the type.
 */
export class BootError extends Error {
  readonly code: BootErrorCode
  /** What to do next, in one sentence. Printed on its own line. */
  readonly remedy: string

  constructor(code: BootErrorCode, message: string, remedy: string) {
    super(message)
    this.name = 'BootError'
    this.code = code
    this.remedy = remedy
  }

  /** What the CLI prints. */
  format(): string {
    return `${this.message}\n  → ${this.remedy}`
  }
}
