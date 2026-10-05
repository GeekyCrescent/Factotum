/**
 * What `claude` is called with to classify one batch (spec 2026-10-05, D6; criterion 10). Pure, and
 * apart from the launching for the reason `buildTitlerArgs` is: the subtlety is here, and split out it
 * is tested without spending a token.
 *
 * WHAT IS MISSING IS PART OF THE CONTRACT, as in the titler: no `--settings`, so no hook; no
 * `--session-id`, because this is not a session. AND NO PROMPT: nothing follows `-p`. The prompt —
 * up to 160 KB of other people's mail — goes by stdin, where `ps` cannot see it (criterion 11).
 */

export interface DigestArgsInput {
  readonly model: string
  readonly effort: string | undefined
  /** The JSON Schema, as a string. */
  readonly schema: string
}

export function buildDigestArgs(input: DigestArgsInput): readonly string[] {
  return [
    '-p',
    '--model',
    input.model,
    ...(input.effort === undefined ? [] : ['--effort', input.effort]),
    // No tools: a mail that gives orders has nothing to carry them out with (guardrail 2).
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
