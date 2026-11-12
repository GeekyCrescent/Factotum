/**
 * What every stage's prompt says (design D4). Pure: `(ctx) → string`, snapshot-tested.
 *
 * The prompts are the module's, not skills of the owner (requirements §7). They are in English; the
 * DOCUMENTS are written in the language of the inputs (criterion 21).
 */

import { join } from 'node:path'
import { INPUTS_DIR, PRIVATE_DIR } from '../inputs.ts'
import { RUN_SPECS } from '../stages.ts'
import type { InputRef, RunKind } from '../types.ts'

export interface PromptContext {
  readonly runId: string
  readonly stage: RunKind
  readonly name: string
  readonly client: string
  readonly vaultDir: string
  readonly workDir: string
  readonly inputs: readonly InputRef[]
  /** A redo: the owner's comment, literal, and where the previous version was copied (relative to vaultDir). */
  readonly redo?: { readonly comment: string; readonly previous: readonly string[] }
}

export function inputsDir(ctx: PromptContext): string {
  return join(ctx.workDir, INPUTS_DIR)
}

export function privateDir(ctx: PromptContext): string {
  return join(ctx.workDir, INPUTS_DIR, PRIVATE_DIR)
}

/** Who, where, and the rules every stage keeps. */
export function preamble(ctx: PromptContext, role: string): string {
  const open = ctx.inputs.filter((input) => !input.private)
  const listed =
    open.length === 0
      ? `There are no inputs listed yet; look in ${inputsDir(ctx)} anyway, and if it is empty, say so in the document.`
      : open.map((input) => `- ${input.name}${input.kind === 'note' ? ' (the owner’s note)' : ''}`).join('\n')
  return [
    `You are working on a mockup for a client of BWR: «${ctx.name}», for ${ctx.client}. ${role}`,
    '',
    '## Where things are',
    '',
    `- The mockup folder, in the owner's Obsidian vault (the documents go here): ${ctx.vaultDir}`,
    `- The work folder (inputs and code): ${ctx.workDir}`,
    `- The inputs: ${inputsDir(ctx)}`,
    '',
    listed,
    '',
    '## Rules',
    '',
    '- Write every document in the language of the inputs (if they are in Spanish, the documents are in Spanish).',
    `- Do NOT open anything in ${privateDir(ctx)}: it is real client data, and only the plan stage may look at it.`,
    '- Word files: read them with `textutil -convert txt -stdout <file>` in the shell.',
    '- PDF files: read them with your file reading tool. A PDF with no text layer (a scan) still renders its pages: read it as an image. Only if you still cannot read it, put that in the open questions.',
    '- Every document starts with a YAML frontmatter block.',
    '- Do not invent what the inputs do not say: what you infer is an assumption, and is written as one.',
  ].join('\n')
}

/** The redo section: the previous version and the owner's comment, literal (criterion 29). */
export function redoSection(ctx: PromptContext): string {
  if (ctx.redo === undefined) return ''
  const previous = ctx.redo.previous.map((path) => `- ${join(ctx.vaultDir, path)}`).join('\n')
  const quoted = ctx.redo.comment
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n')
  return [
    '',
    '## This is a redo',
    '',
    'The owner reviewed the previous version and asked for changes. The previous version was copied here:',
    '',
    previous,
    '',
    'The owner’s comment, literal:',
    '',
    quoted,
    '',
    'Rewrite the document in place, starting from the previous version and doing what the comment asks. Keep what the comment does not touch.',
  ].join('\n')
}

/** How the stage ends: the exact files, and `submit_stage` with its runId. */
export function closing(ctx: PromptContext): string {
  const files = RUN_SPECS[ctx.stage].files
  return [
    '',
    '## When you are done',
    '',
    `Call the tool \`submit_stage\` with runId \`${ctx.runId}\`, files ${JSON.stringify(files)} and a one-sentence summary. ` +
      'If it refuses, fix what it says and call it again. When it accepts, end your turn: the owner reviews it from the phone.',
  ].join('\n')
}
