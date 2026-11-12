/**
 * The plan (design D4; criteria 23, 24, 28, 34, 35): from the approved brief and the CHOSEN concept,
 * the story and its steps, the pages, the invented data, and 2–3 visual directions — written in the
 * vault and shown as a static site in `<workDir>/directions/`, deployed to a preview. The owner chooses
 * one direction by opening its page on the phone. The structure comes from the mockups made by hand
 * (requirements §0.1), never their content.
 */

import { join } from 'node:path'
import { vercelProjectOf } from '../stages.ts'
import { choiceSection, closing, deploySection, docPath, preamble, redoSection, type PromptContext } from './common.ts'

export function directionsDir(ctx: PromptContext): string {
  return join(ctx.workDir, 'directions')
}

export function planPrompt(ctx: PromptContext): string {
  const site = directionsDir(ctx)
  return [
    preamble(ctx, 'This stage is the PLAN: from the approved brief and the concept the owner chose, plan the demo step by step and propose two or three visual directions the owner can open on the phone.'),
    choiceSection(ctx),
    ...(ctx.redo === undefined ? [] : [redoSection(ctx)]),
    '',
    '## What to read',
    '',
    `- The approved brief: ${docPath(ctx, '01-brief.md')}`,
    `- The concepts: ${docPath(ctx, '02-concepts.md')} — only the chosen one matters now.`,
    '',
    '## What to write in the mockup folder',
    '',
    'Every document starts with frontmatter: `title`, `type`, `client`, `created` (today, YYYY-MM-DD) and `concept` (the id of the chosen concept).',
    '',
    `1. ${docPath(ctx, '03-story-and-pages.md')} (\`type: mockup-plan\`):`,
    '   - **Story** — the demo in one sentence.',
    '   - **Steps** — 6 to 12 numbered steps, as the presenter clicks through them. Mark exactly ONE as the step that sells it, the one the brief and the concept point at. Never several.',
    '   - **Pages** — each page (a Next.js route by default; a PWA only if the brief asks for one) with the steps it serves, by number.',
    `2. ${docPath(ctx, '04-data.md')} (\`type: mockup-data\`): the cast (the invented people or things the demo shows, with names), the scenario (what happened before the demo starts), and the quantities in a table. All invented, never real.`,
    `3. ${docPath(ctx, '05-visual-direction.md')} (\`type: mockup-directions\`, and \`options: [a, b]\` with the ids on one line): 2 or 3 directions, each under \`## <id> — <title>\`, with:`,
    '   - its tokens: colours (with their values), type, spacing, radius;',
    '   - the contrast of every text and background pair, checked: 4.5:1 or more for body text;',
    '   - a table `| Step | Animation | What it causes |`. Every row names a step of 03-story-and-pages.md by its number and name: an animation that serves no step does not go in.',
    '',
    '## The directions, as pages',
    '',
    `In ${site}/ make a static site, plain HTML, CSS and JavaScript, no build step and nothing to install:`,
    '',
    '- `index.html`, linking to each direction;',
    '- one page per direction, `<id>.html`, that shows THE STEP THAT SELLS IT in that direction, with its animations running. It must work on a phone (390 px wide) and respect `prefers-reduced-motion`.',
    '',
    'The data on the pages comes from 04-data.md. Do not touch `_versions/` in that folder.',
    deploySection(site, vercelProjectOf(ctx.project, 'plan') ?? `${ctx.project}-directions`),
    '',
    '## Handing it in',
    '',
    'Pass `options` to `submit_stage`: one per direction, with the same `id` and `title` as in 05-visual-direction.md, a one-sentence `blurb`, and `url` = the deployment URL followed by `/<id>.html`. 2 or 3 options.',
    closing(ctx),
  ].join('\n')
}
