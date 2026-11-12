/**
 * Deliver (design D4; criteria 33, 35, 37): the APPROVED app, unchanged, from `<workDir>/mockup-app/`
 * to production on `<slug>-mockup`, and the presenter guide `06-presenter-guide.md` in the vault. No
 * gate: once it is accepted the mockup is delivered.
 *
 * The guide's sections are those of the guides made by hand (`guia-presentador-maqueta.md`,
 * requirements §0.1): the structure, never the content.
 */

import { vercelProjectOf } from '../stages.ts'
import { appDir, closing, docPath, preamble, productionSection, type PromptContext } from './common.ts'

export function deliverPrompt(ctx: PromptContext): string {
  const app = appDir(ctx)
  const guide = docPath(ctx, '06-presenter-guide.md')
  return [
    preamble(ctx, 'This stage is the DELIVERY: the owner approved the build; put it in production and write the guide that lets someone who has never seen the mockup present it to the client.'),
    '',
    '## What to read',
    '',
    `- The brief: ${docPath(ctx, '01-brief.md')} — its assumptions, open questions and what is out of scope.`,
    `- The story and its steps: ${docPath(ctx, '03-story-and-pages.md')}`,
    `- The invented data: ${docPath(ctx, '04-data.md')}`,
    `- The chosen direction: ${docPath(ctx, '05-visual-direction.md')} (\`chosen:\` in its frontmatter).`,
    `- The app itself, in ${app}: its pages are what the guide walks through. Do not describe a screen it does not have.`,
    ...(ctx.urls?.preview === undefined ? [] : [`- The preview the owner approved: ${ctx.urls.preview}`]),
    '',
    `Do not change the app: the owner approved it as it is. If it no longer builds or deploys, say so and end your turn.`,
    productionSection(app, vercelProjectOf(ctx.project, 'deliver') ?? `${ctx.project}-mockup`),
    '',
    '## The presenter guide',
    '',
    `Write ${guide} (\`type: mockup-presenter-guide\`, \`url:\` the production alias), in the language of the inputs, for someone who has never seen the mockup and presents it to the client. Its sections:`,
    '',
    '1. **What the mockup is, and is not** — a clickable prototype of the proposal; no real systems behind it; every datum invented. What is shown becomes a promise: say it out loud at the start and at the end.',
    '2. **How to open it** — the production URL, on which device each part is shown (phone or laptop), and a short checklist before starting.',
    '3. **Demo props** — the people, records and numbers of 04-data.md the presenter will use, so nobody improvises a name.',
    '4. **The walk-through, step by step** — an opening of 30 seconds; then each step of 03-story-and-pages.md in order, with the page, what to click, and what to say; the step that sells it marked, with what to pause on while its animation runs; a closing of 30 seconds.',
    '5. **Awkward questions** — the ones the brief’s assumptions and open questions invite, each with an honest answer.',
    '6. **Out of scope** — what the mockup does not show, from the brief.',
    '',
    '## Handing it in',
    '',
    'Pass `prodUrl` to `submit_stage`: the production alias, once it answers 200.',
    closing(ctx),
  ].join('\n')
}
