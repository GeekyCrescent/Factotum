/**
 * How long a question or an ask waits for the owner, SHORTENED IN `dev` ONLY (spec
 * 2026-10-01-preguntas-con-opciones, D5 ter).
 *
 * The window is an hour less thirty seconds, and the criterion that says expiring leaves the session
 * alive cannot be checked by hand at that price. So `FACTOTUM_ASK_TIMEOUT_SECONDS` shortens it — in
 * `dev`. In `prod` it is ignored, and said, so a variable left in a shell profile cannot quietly give
 * the owner a minute to answer from their pocket.
 *
 * ONE KNOB for both: the permission ask shortens with it, on purpose.
 */

import { ASK_TIMEOUT_SECONDS, type EngineDeps } from '@factotum/sessions'

export const ASK_TIMEOUT_VARIABLE = 'FACTOTUM_ASK_TIMEOUT_SECONDS'
/** Shorter than this and the push may land after the window has closed. */
export const MIN_ASK_TIMEOUT_SECONDS = 30

/** `{}` or `{ askTimeoutMs }`; NEVER `{ askTimeoutMs: undefined }` (exactOptionalPropertyTypes). */
export function askTimeoutFrom(
  env: string,
  vars: Readonly<Record<string, string | undefined>>,
  warn: (message: string) => void,
): Pick<EngineDeps, 'askTimeoutMs'> {
  const raw = vars[ASK_TIMEOUT_VARIABLE]
  if (raw === undefined) return {}
  if (env !== 'dev') {
    warn(`${ASK_TIMEOUT_VARIABLE} is only read in dev; ignored in ${env}`)
    return {}
  }
  const seconds = /^\d+$/.test(raw) ? Number(raw) : Number.NaN
  if (!Number.isInteger(seconds) || seconds < MIN_ASK_TIMEOUT_SECONDS || seconds > ASK_TIMEOUT_SECONDS) {
    warn(`${ASK_TIMEOUT_VARIABLE}=${raw} ignored: it takes whole seconds from ${MIN_ASK_TIMEOUT_SECONDS} to ${ASK_TIMEOUT_SECONDS}`)
    return {}
  }
  return { askTimeoutMs: seconds * 1000 }
}
