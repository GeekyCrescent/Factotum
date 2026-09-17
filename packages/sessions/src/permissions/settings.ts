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
 * How long the CLI waits for a decision, in seconds — and so THE WINDOW A PERSON HAS TO ANSWER
 * AN ASK FROM THEIR POCKET.
 *
 * It used to be ten, reasoned for a gate that could only allow or deny: `decide` is pure, the
 * real figure was microseconds. With `ask` (ADR-0009) that reasoning expired, and this is the
 * same role the predecessor gave its hook timeout.
 *
 * AN HOUR, the owner's choice (2026-09-16), and the predecessor's default. Measured, not
 * assumed: the CLI held a hook's reply for 700 s under `timeout: 3600` and answered in time
 * (spec §0.32), and the predecessor verified the setting accepts 3600. When it expires the
 * tool is blocked and the session carries on — measured too: it is a deny, not a dead session.
 *
 * The cost is written, not hidden: an ask nobody sees freezes that agent for up to an hour.
 * Most asks in the predecessor were agents asking to do what they were told — a wide site
 * makes fewer of them.
 */
export const HOOK_TIMEOUT_SECONDS = 3600

/**
 * What factotum needs, after it gives up on an ask, to write why into the log and answer before
 * the CLI's own timeout fires. The work is milliseconds — an append and a response. Thirty
 * seconds also absorbs the gap between when the CLI starts its clock and when the request
 * reaches the daemon, three orders of magnitude over.
 */
export const ASK_ANSWER_MARGIN_SECONDS = 30

/**
 * How long factotum waits for the owner. A SUBTRACTION, not a second literal: two numbers drift
 * the day someone changes one, and this cannot. The test asserts the inequality anyway, because
 * a negative margin would still compile.
 */
export const ASK_TIMEOUT_SECONDS = HOOK_TIMEOUT_SECONDS - ASK_ANSWER_MARGIN_SECONDS

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
