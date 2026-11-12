/**
 * A change after delivery (design D4; criterion 36): the client's request as the owner wrote it,
 * literal; the app edited in place in `<workDir>/mockup-app/`, built clean and deployed to a PREVIEW of
 * `<slug>-mockup` — the change's own gate opens it. Production is the redeploy's, after approval.
 */

import { vercelProjectOf } from '../stages.ts'
import { appRedoSection } from './build.ts'
import { appDir, closing, deploySection, docPath, preamble, requestSection, type PromptContext } from './common.ts'

export function changePrompt(ctx: PromptContext): string {
  const app = appDir(ctx)
  return [
    preamble(ctx, 'This is a CHANGE to a mockup already delivered: the client asked for it, and the owner wrote it down. Make it in the app and deploy it to a preview the owner reviews from the phone.'),
    requestSection('The request, literal', ctx.change?.text ?? ''),
    appRedoSection(ctx, ctx.change?.previewUrl),
    '',
    '## What to read',
    '',
    `- The app, in ${app}: it is in production${ctx.urls?.prod === undefined ? '' : ` at ${ctx.urls.prod}`}.`,
    `- The story and its steps: ${docPath(ctx, '03-story-and-pages.md')}; the data: ${docPath(ctx, '04-data.md')}; the chosen direction: ${docPath(ctx, '05-visual-direction.md')}.`,
    '',
    '## What to do',
    '',
    `Do what the request asks in ${app}, and nothing else: no redesign, no tidying, no new step. New data goes in the app's one data file, invented, never real. The same rules as the build: phone (390 px) and laptop, \`prefers-reduced-motion\`.`,
    `Then \`npm run build\` in ${app}: it must build clean, with no errors. Do not write in the mockup folder: the redeploy does, once the owner approves.`,
    deploySection(app, vercelProjectOf(ctx.project, 'change') ?? `${ctx.project}-mockup`, true),
    '',
    '## Handing it in',
    '',
    'Pass `previewUrl` to `submit_stage`: the deployment URL, once it answers 200.',
    closing(ctx),
  ].join('\n')
}
