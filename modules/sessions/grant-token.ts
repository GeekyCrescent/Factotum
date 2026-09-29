/**
 * The folder-request token a notification put in the URL (`?grant=`), for approving without
 * notification buttons (spec 2026-09-29, D3). The twin of `ask-token.ts`: same shape, same rule.
 *
 * In a `.ts` so a test can import it: `node --test` strips types but does not transform JSX.
 */

/** Same shape the engine issues: 32 random bytes, base64url. Anything else is not ours. */
const TOKEN = /^[A-Za-z0-9_-]{43}$/

/** `?grant=<token>` → the token; anything malformed → `undefined`. */
export function grantTokenFrom(search: string): string | undefined {
  const value = new URLSearchParams(search).get('grant')
  return value !== null && TOKEN.test(value) ? value : undefined
}
