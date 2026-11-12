/**
 * The build (design D4; criteria 32, 34, 35, 37): from the approved plan and the direction the owner
 * chose, the clickable app in `<workDir>/mockup-app/`, every datum from ONE file seeded from
 * `04-data.md`, built clean and deployed to a Vercel PREVIEW of `<slug>-mockup` — the owner opens it at
 * the gate from the phone. Production is deliver's, never the build's.
 *
 * A redo edits the app in place: the previous preview stays live at its own URL, which is the version
 * kept (Vercel keeps every deployment), so nothing is copied aside.
 */

import { join } from 'node:path'
import { vercelProjectOf } from '../stages.ts'
import { appDir, choiceSection, closing, deploySection, docPath, preamble, quote, type PromptContext } from './common.ts'

/** Where the build keeps the demo's data: one file (D4). A suggestion; the rule is that there is one. */
const APP_DATA = 'data/demo.ts'

/** The redo of an app: the comment, literal, and the preview it replaces (criterion 29). */
export function appRedoSection(ctx: PromptContext, previewUrl: string | undefined): string {
  if (ctx.redo === undefined) return ''
  return [
    '',
    '## This is a redo',
    '',
    `The owner reviewed the previous version and asked for changes. The previous version is the app as it is now in ${appDir(ctx)}${previewUrl === undefined ? '' : `, deployed at ${previewUrl}`}.`,
    '',
    'The owner’s comment, literal:',
    '',
    quote(ctx.redo.comment),
    '',
    'Change the app in place, doing what the comment asks. Keep what the comment does not touch.',
  ].join('\n')
}

export function buildPrompt(ctx: PromptContext): string {
  const app = appDir(ctx)
  const chosen = ctx.chosen?.option.id
  return [
    preamble(ctx, 'This stage is the BUILD: from the approved plan and the visual direction the owner chose, build the mockup as a clickable app the presenter walks through, and deploy it to a preview the owner opens on the phone.'),
    choiceSection(ctx),
    appRedoSection(ctx, ctx.urls?.preview),
    '',
    '## What to read',
    '',
    `- The approved brief: ${docPath(ctx, '01-brief.md')} — what is functional and what is simulated, and what is out of scope.`,
    `- The story, its steps and the pages: ${docPath(ctx, '03-story-and-pages.md')}`,
    `- The invented data: ${docPath(ctx, '04-data.md')}`,
    `- The visual directions: ${docPath(ctx, '05-visual-direction.md')} — only the chosen one${chosen === undefined ? '' : ` (\`chosen: ${chosen}\` in its frontmatter)`}: its tokens and its step → animation table.`,
    ...(chosen === undefined ? [] : [`- That direction's page, the reference for the step that sells it: ${join(ctx.workDir, 'directions', `${chosen}.html`)}`]),
    '',
    '## What to build',
    '',
    `In ${app}/ build the app (Next.js, unless 03-story-and-pages.md says a PWA):`,
    '',
    '- every page of 03-story-and-pages.md, so the presenter can click through every step in order, from the first to the last;',
    '- the step that sells it, with the animations of the chosen direction exactly as its table says; every animation serves the step its row names, and nothing else moves;',
    `- ALL the data from ONE file in the app (for example \`${APP_DATA}\`), seeded from 04-data.md: no other file holds a name, a number or a date the demo shows;`,
    '- nothing real: no backend, no login, no calls to outside services; what the brief says is simulated, is simulated in the app;',
    '- it works on a phone (390 px wide) and on a laptop, and respects `prefers-reduced-motion`.',
    '',
    `Then \`npm install\` and \`npm run build\` in ${app}: it must build clean, with no errors. Do not touch ${join(ctx.workDir, 'directions')}.`,
    deploySection(app, vercelProjectOf(ctx.project, 'build') ?? `${ctx.project}-mockup`),
    '',
    '## Handing it in',
    '',
    'Pass `previewUrl` to `submit_stage`: the deployment URL, once it answers 200.',
    closing(ctx),
  ].join('\n')
}
