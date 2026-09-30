/**
 * What `claude` is called with to title a conversation (spec 2026-09-30, D5). Pure, and separate
 * from the launching for the reason `buildArgs` is (`run.ts`): the subtlety is here, and split out
 * it is tested without spending a token.
 *
 * WHAT IS MISSING IS PART OF THE CONTRACT. No `--settings`, so no hook: with `--tools ""` there is
 * nothing for the gate to decide, and the titler has no meta the gate would recognise anyway. No
 * `--session-id` or `--resume`: this is not a session.
 */

export interface TitlerArgsInput {
  readonly prompt: string
  readonly model: string
  readonly effort: string
}

export function buildTitlerArgs(input: TitlerArgsInput): readonly string[] {
  return [
    '-p',
    input.prompt,
    '--model',
    input.model,
    '--effort',
    input.effort,
    // No tools. Measured: the model then WRITES a tool call as text, and nothing runs.
    '--tools',
    '',
    // Otherwise every title would leave a conversation in the owner's own history.
    '--no-session-persistence',
    // None of the owner's machinery: slower, and nothing a titler has any business near.
    '--strict-mcp-config',
    '--setting-sources',
    '',
    '--output-format',
    'text',
  ]
}
