/**
 * The `--settings` file, one per session.
 *
 * It is ADDITIONAL to `~/.claude`, not a replacement, which is what lets the owner's
 * own configuration keep working while this gate is bolted on. Block A confirmed the
 * consequence: the owner's own `PreToolUse` hooks run too — eight of them, on that
 * machine, for a single `Write` — and a `deny` from this one still wins. The gate is
 * not something the owner's settings can switch off by accident.
 */

export const HOOK_PATH = 'hooks/pre-tool-use'

/**
 * How long the CLI waits for a decision, in seconds.
 *
 * A NAMED CONSTANT WITH ITS REASONING, NOT A 30 SOMEBODY TYPED. In the predecessor
 * this was derived from the approval timeout, because there the hook's timeout WAS the
 * window a human had to answer in. Here ADR-0006 removes approval entirely, so there
 * is nothing to derive it from: it is an upper bound on how long a decision that does
 * no network I/O can possibly take, and `decide` is pure, so the real figure is
 * microseconds. Ten seconds is three orders of magnitude of headroom for a loaded
 * machine, and it is deliberately not generous beyond that — a hook that hangs is a
 * session that hangs.
 */
export const HOOK_TIMEOUT_SECONDS = 10

export interface HookSettings {
  readonly hooks: {
    readonly PreToolUse: readonly {
      readonly matcher: string
      readonly hooks: readonly { readonly type: 'http'; readonly url: string; readonly timeout: number }[]
    }[]
  }
}

/**
 * THE MATCHER IS `*`, ON PURPOSE.
 *
 * Narrowing it to the tools that appear in some rule would leave the boundary check
 * blind, because a `Write` to an arbitrary absolute path does not look like any
 * pattern. The cost is one request to this same host per tool call; the cost of the
 * alternative is a permanent hole.
 */
export function hookSettings(hookUrl: string): HookSettings {
  return {
    hooks: {
      PreToolUse: [
        {
          matcher: '*',
          hooks: [
            {
              type: 'http',
              url: `${hookUrl.replace(/\/+$/, '')}/modules/sessions/${HOOK_PATH}`,
              timeout: HOOK_TIMEOUT_SECONDS,
            },
          ],
        },
      ],
    },
  }
}

export function serializeSettings(settings: HookSettings): string {
  return `${JSON.stringify(settings, null, 2)}\n`
}
