/**
 * What `claude` is called with for a generation (design D10). Pure.
 *
 * COPIED FROM packages/tasks/src/ai (`args.ts`; requirements §0.2, S11), with ONE change (A4, design D10
 * «Lo fijo y la caché»): `systemFile` → `--append-system-prompt-file <path>`. The fixed prefix (the
 * master CV and the guide) goes as a FILE, never as argv text `ps` could show, and as a system prompt
 * so the CLI's cache holds it across runs (measured: −73 % per CV).
 *
 * WHAT IS MISSING IS PART OF THE CONTRACT: no `--settings`, so no hook; no `--session-id`, because
 * this is not a session. AND NO PROMPT: nothing follows `-p`. What varies goes by stdin.
 */

export interface ClaudeArgsInput {
  readonly model: string
  readonly effort: string | undefined
  /** The JSON Schema, as a string, in draft-07. */
  readonly schema: string
  /** `<stateDir>/prompts/master-<sha256>.txt` (A4); absent = no fixed prefix. */
  readonly systemFile?: string | undefined
}

export function buildClaudeArgs(input: ClaudeArgsInput): readonly string[] {
  return [
    '-p',
    '--model',
    input.model,
    ...(input.effort === undefined ? [] : ['--effort', input.effort]),
    // No tools: a generation has nothing to carry out (guardrail 2).
    '--tools',
    '',
    '--no-session-persistence',
    '--strict-mcp-config',
    '--setting-sources',
    '',
    ...(input.systemFile === undefined ? [] : ['--append-system-prompt-file', input.systemFile]),
    '--output-format',
    'json',
    '--json-schema',
    input.schema,
  ]
}
