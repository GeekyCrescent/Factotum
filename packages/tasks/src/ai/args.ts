/**
 * What `claude` is called with to read a capture or to answer «What's next?» (design D5). Pure, and
 * apart from the launching for the reason the inbox's `buildDigestArgs` is: the subtlety is here, and
 * split out it is tested without spending a token.
 *
 * WHAT IS MISSING IS PART OF THE CONTRACT (requirements §0.9): no `--settings`, so no hook; no
 * `--session-id`, because this is not a session. AND NO PROMPT: nothing follows `-p`. The prompt —
 * the owner's own words — goes by stdin, where `ps` cannot see it.
 */

export interface ClaudeArgsInput {
  readonly model: string
  readonly effort: string | undefined
  /** The JSON Schema, as a string, in draft-07 (`schema.ts`). */
  readonly schema: string
}

export function buildClaudeArgs(input: ClaudeArgsInput): readonly string[] {
  return [
    '-p',
    '--model',
    input.model,
    ...(input.effort === undefined ? [] : ['--effort', input.effort]),
    // No tools: a task that gives orders has nothing to carry them out with (guardrail 2).
    '--tools',
    '',
    '--no-session-persistence',
    '--strict-mcp-config',
    '--setting-sources',
    '',
    '--output-format',
    'json',
    '--json-schema',
    input.schema,
  ]
}
