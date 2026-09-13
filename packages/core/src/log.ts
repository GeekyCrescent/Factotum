/**
 * The smallest logger that lets the kernel and every module agree on a prefix.
 *
 * Deliberately not a logging library: a self-hosted single-user daemon writing to a
 * terminal does not need levels, transports or structured output, and adding them
 * later is cheaper than removing them.
 */

export interface Logger {
  info: (message: string) => void
  warn: (message: string) => void
  error: (message: string) => void
}

/** `prefixed('factotum')` writes `[factotum] …`; modules get `[<id>]`. */
export function prefixed(prefix: string, sink: Console = console): Logger {
  const tag = `[${prefix}]`
  return {
    info: (message) => sink.error(`${tag} ${message}`),
    warn: (message) => sink.error(`${tag} ${message}`),
    error: (message) => sink.error(`${tag} ${message}`),
  }
}
