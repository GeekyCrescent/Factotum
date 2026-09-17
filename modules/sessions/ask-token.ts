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
