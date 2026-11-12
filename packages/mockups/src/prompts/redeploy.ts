/**
 * The redeploy of an approved change (design D4; criterion 36): the app as the owner approved it, to
 * production on `<slug>-mockup`; one line in `<vaultDir>/changes.md` (date, request, URL); and the
 * presenter guide touched only if the change moves a step of the walk-through. No gate: accepted, the
 * change is done.
 */

import { vercelProjectOf } from '../stages.ts'
import { appDir, closing, docPath, preamble, productionSection, requestSection, type PromptContext } from './common.ts'

export function redeployPrompt(ctx: PromptContext): string {
  const app = appDir(ctx)
  const changes = docPath(ctx, 'changes.md')
  return [
    preamble(ctx, 'This is the REDEPLOY of a change the owner approved: put it in production and record it.'),
    requestSection('The change, literal', ctx.change?.text ?? ''),
    ...(ctx.change?.previewUrl === undefined ? [] : ['', `The owner approved it on this preview: ${ctx.change.previewUrl}`]),
    '',
    `Do not change the app: deploy ${app} as it is. If it no longer builds or deploys, say so and end your turn.`,
    productionSection(app, vercelProjectOf(ctx.project, 'redeploy') ?? `${ctx.project}-mockup`),
    '',
    '## Recording it',
    '',
    `- Add one line at the end of ${changes}: \`- YYYY-MM-DD — <the request in one line> — <the production alias>\` (today's date). If the file does not exist, create it with a frontmatter (\`title\`, \`type: mockup-changes\`) and a heading first.`,
    `- Update ${docPath(ctx, '06-presenter-guide.md')} only if the change touches a step of its walk-through; leave it as it is otherwise.`,
    '',
    '## Handing it in',
    '',
    'Pass `prodUrl` to `submit_stage`: the production alias, once it answers 200.',
    closing(ctx),
  ].join('\n')
}
