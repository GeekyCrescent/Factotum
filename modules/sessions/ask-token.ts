/**
 * The ask token a notification put in the URL, for answering without notification buttons
 * (spec criterion 55).
 *
 * In a `.ts` so a test can import it: `node --test` strips types but does not transform JSX.
 */

/** Same shape the engine issues: 32 random bytes, base64url. Anything else is not ours. */
const TOKEN = /^[A-Za-z0-9_-]{43}$/

/** `?ask=<token>` → the token; anything malformed → `undefined`. */
export function askTokenFrom(search: string): string | undefined {
  const value = new URLSearchParams(search).get('ask')
  return value !== null && TOKEN.test(value) ? value : undefined
}

/**
 * The same URL WITHOUT the token, to put back with `history.replaceState`. The phone's history is
 * not somewhere the agent can read, but a one-use token left in history — or carried along when
 * the address is copied — is debris with no reason to exist (criterion 58). Other parameters stay.
 */
export function withoutAskToken(pathname: string, search: string): string {
  const params = new URLSearchParams(search)
  params.delete('ask')
  const rest = params.toString()
  return rest === '' ? pathname : `${pathname}?${rest}`
}

/** The public id of a batch: 16 bytes, hex (spec 2026-10-01-preguntas-con-opciones, D2). */
const BATCH = /^[0-9a-f]{32}$/

/**
 * `?questions=<token>&batch=<id>` → both; anything malformed → `undefined`. The batch travels with
 * the token so the screen can tell WHICH pending the token belongs to without matching tokens (D10).
 * No `withoutQuestionsToken`: the router already drops the whole query before the first render.
 */
export function questionsTokenFrom(search: string): { readonly token: string; readonly batch: string } | undefined {
  const params = new URLSearchParams(search)
  const token = params.get('questions')
  const batch = params.get('batch')
  if (token === null || batch === null || !TOKEN.test(token) || !BATCH.test(batch)) return undefined
  return { token, batch }
}
