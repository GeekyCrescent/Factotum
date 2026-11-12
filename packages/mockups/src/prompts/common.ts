/**
 * What every stage's prompt says (design D4). Pure: `(ctx) → string`, snapshot-tested.
 *
 * The prompts are the module's, not skills of the owner (requirements §7). They are in English; the
 * DOCUMENTS are written in the language of the inputs (criterion 21).
 */

import { isAbsolute, join } from 'node:path'
import { INPUTS_DIR, PRIVATE_DIR } from '../inputs.ts'
import { APP_DIR, RUN_SPECS } from '../stages.ts'
import type { InputRef, RunKind, StageId, StageOption } from '../types.ts'

export interface PromptContext {
  readonly runId: string
  readonly stage: RunKind
  /** The vault project's slug: it names the Vercel projects (`<project>-directions`, D4). */
  readonly project: string
  readonly name: string
  readonly client: string
  readonly vaultDir: string
  readonly workDir: string
  readonly inputs: readonly InputRef[]
  /** A redo: the owner's comment, literal, and where the previous version was copied (relative to vaultDir). */
  readonly redo?: { readonly comment: string; readonly previous: readonly string[] }
  /** What the owner chose at the stage before this one, and the document it is in (criterion 28). */
  readonly chosen?: { readonly stage: StageId; readonly file: string; readonly option: StageOption }
  /** The mockup's deployments so far: a redo of the app names the preview it replaces. */
  readonly urls?: { readonly preview?: string; readonly prod?: string }
}

/** The absolute path of a document of the mockup folder. */
export function docPath(ctx: PromptContext, file: string): string {
  return join(ctx.vaultDir, file)
}

export function inputsDir(ctx: PromptContext): string {
  return join(ctx.workDir, INPUTS_DIR)
}

export function privateDir(ctx: PromptContext): string {
  return join(ctx.workDir, INPUTS_DIR, PRIVATE_DIR)
}

/**
 * The private inputs (D4; criterion 35): off limits everywhere but plan, and in plan only to learn the
 * shape of the real data, so the invented data looks like it. The guard refuses a copy either way.
 */
function privateRule(ctx: PromptContext): string {
  if (ctx.stage !== 'plan') return `- Do NOT open anything in ${privateDir(ctx)}: it is real client data, and only the plan stage may look at it.`
  return (
    `- ${privateDir(ctx)} holds real client data. You may open it only to learn the SHAPE of the data (columns, formats, ranges, how many), ` +
    'so the invented data looks real. Never copy a file or a value from it into a document or a page: the module refuses the stage if it finds a copy.'
  )
}

/** Who, where, and the rules every stage keeps. */
export function preamble(ctx: PromptContext, role: string): string {
  const open = ctx.inputs.filter((input) => !input.private)
  const listed =
    open.length === 0
      ? `There are no inputs listed yet; look in ${inputsDir(ctx)} anyway, and if it is empty, say so in the document.`
      : open.map((input) => `- ${input.name}${input.kind === 'note' ? ' (the owner’s note)' : ''}`).join('\n')
  return [
    `You are working on a mockup: «${ctx.name}», for ${ctx.client}. ${role}`,
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
    privateRule(ctx),
    '- Word files: read them with `textutil -convert txt -stdout <file>` in the shell.',
    '- PDF files: read them with your file reading tool. A PDF with no text layer (a scan) still renders its pages: read it as an image. Only if you still cannot read it, put that in the open questions.',
    '- Every document starts with a YAML frontmatter block.',
    '- Do not invent what the inputs do not say: what you infer is an assumption, and is written as one.',
  ].join('\n')
}

/** The owner's words as a Markdown quote, line by line: literal, and plainly not the module's. */
export function quote(text: string): string {
  return text
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n')
}

/** The redo section: the previous version and the owner's comment, literal (criterion 29). */
export function redoSection(ctx: PromptContext): string {
  if (ctx.redo === undefined) return ''
  const previous = ctx.redo.previous.map((path) => `- ${isAbsolute(path) ? path : join(ctx.vaultDir, path)}`).join('\n')
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
    quote(ctx.redo.comment),
    '',
    'Rewrite the document in place, starting from the previous version and doing what the comment asks. Keep what the comment does not touch.',
  ].join('\n')
}

/** The choice of the stage before, so this one builds on it and on nothing else (criterion 28). */
export function choiceSection(ctx: PromptContext): string {
  if (ctx.chosen === undefined) return ''
  const { option, file, stage } = ctx.chosen
  return [
    '',
    `## What the owner chose at ${stage}`,
    '',
    `The owner chose «${option.title}» (${option.id}): ${option.blurb}`,
    `It is described in ${docPath(ctx, file)} (its frontmatter says \`chosen: ${option.id}\`). Build on that one; the others were not chosen.`,
  ].join('\n')
}

/**
 * Publishing a folder to a Vercel PREVIEW, and opening it only once it is clear (D4, measured in A3;
 * criteria 34, 35): protection ON before deploying, `check_real_data` on what was deployed, and only
 * then protection OFF — so a copy of real client data is never public, not even for a moment. The URL
 * must answer 200 before it is handed in. A failed `vercel` ends the turn without submitting (crit. 37).
 */
export function deploySection(dir: string, vercelProject: string): string {
  return [
    '',
    '## Publishing',
    '',
    `Publish ${dir} to a Vercel preview, from inside that folder, in this order:`,
    '',
    `1. \`vercel project add ${vercelProject}\` — an answer that it already exists is fine.`,
    `2. \`vercel link --yes --project ${vercelProject}\``,
    `3. \`vercel project protection enable ${vercelProject} --sso\` — so nothing is public before it is checked.`,
    '4. `vercel deploy --yes` — a preview, never `--prod`. It prints the deployment URL (https://….vercel.app).',
    '5. Call the tool `check_real_data` with your runId. If it is not clear, do what it says: `vercel remove <url> --yes`, fix, and start again at step 4. Never skip it.',
    `6. Only once it is clear: \`vercel project protection disable ${vercelProject} --sso\` — the owner opens the previews on the phone without logging in.`,
    '7. `curl -s -o /dev/null -w "%{http_code}" <url>` on every URL you will hand in, until each answers 200. It takes a few seconds after step 6; keep trying for up to two minutes. Never hand in a URL that does not answer 200.',
    '',
    'If `vercel` fails (not logged in, no network, a quota) or a URL never answers 200, do NOT call `submit_stage`: say in your reply what failed, with the command and its error, and end your turn. The owner retries the stage.',
  ].join('\n')
}

/** The absolute path of the app in the work folder (crit. 32). */
export function appDir(ctx: PromptContext): string {
  return join(ctx.workDir, APP_DIR)
}

/** How the stage ends: the exact files, and `submit_stage` with its runId. */
export function closing(ctx: PromptContext): string {
  const spec = RUN_SPECS[ctx.stage]
  const files = [...spec.files, ...(spec.workFiles ?? [])]
  return [
    '',
    '## When you are done',
    '',
    `Call the tool \`submit_stage\` with runId \`${ctx.runId}\`, files ${JSON.stringify(files)} and a one-sentence summary. ` +
      'If it refuses, fix what it says and call it again. When it accepts, end your turn: the owner reviews it from the phone.',
  ].join('\n')
}
