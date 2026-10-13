/**
 * Shared by tests, and only by tests. Lives outside `*.test.ts` so two test files can import it
 * without one running the other's tests.
 */

/**
 * The table of criterion 6 (spec 2026-10-07, design D3): every `rest` after `/peers/<name>` that
 * must build NO URL. `peers.test.ts` checks it against `url()`; `proxy.test.ts` checks it through
 * the whole proxy, with the fake peer's call count at zero.
 */
export const REFUSED_RESTS = [
  '//evil.com/x',
  '/modules/../push',
  '/%2e%2e/push/subscriptions',
  '/modules/x/%2F%2Fevil',
  '/@evil.com',
  '/modules\\..\\push',
  '/push/relay',
  '/hosts',
  '/peers/x/health',
  '/',
] as const
