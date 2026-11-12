/**
 * The concepts (design D4; criteria 21, 28): 2–3 angles on the approved brief, each with its line,
 * for whom, the step that would sell it and its risk. The owner CHOOSES one at the gate, and the plan
 * builds on it. The structure comes from the mockups made by hand (requirements §0.1), never their
 * content.
 */

import { closing, docPath, preamble, redoSection, type PromptContext } from './common.ts'

export function conceptsPrompt(ctx: PromptContext): string {
  return [
    preamble(ctx, 'This stage is the CONCEPTS: from the approved brief, propose two or three different angles for the mockup, so the owner can choose one.'),
    ...(ctx.redo === undefined ? [] : [redoSection(ctx)]),
    '',
    '## What to read',
    '',
    `The approved brief: ${docPath(ctx, '01-brief.md')}. It is the source of truth; go back to the inputs only to check a detail.`,
    '',
    '## What to write',
    '',
    `One file: ${docPath(ctx, '02-concepts.md')}`,
    '',
    'Frontmatter: `title`, `type: mockup-concepts`, `client`, `created` (today, YYYY-MM-DD) and `options` (the ids of the concepts, in order, on one line: `options: [a, b, c]`).',
    '',
    'Then 2 or 3 concepts, each under its own heading `## <id> — <title>`, where the id is a short lower-case slug (`a`, `b`, `c` is fine). Each concept says:',
    '',
    '1. **The line** — the idea in one sentence, as the owner would say it out loud.',
    '2. **For whom** — who it speaks to (someone on the client\'s side, or the users of the owner\'s own project, as the brief tells) and what they care about.',
    '3. **The step that would sell it** — ONE step of the demo, the moment it clicks (the brief marks one; a concept may move it).',
    '4. **Risk** — what could go wrong with this angle, or what the brief does not settle for it.',
    '',
    'The concepts must be really different angles, not three wordings of the same one. Keep to what the brief says the mockup must show; nothing out of scope comes back in.',
    '',
    'When you call `submit_stage`, pass `options`: one per concept, with the same `id` and `title` as in the document and a one-sentence `blurb` (the line). 2 or 3 options, never more.',
    closing(ctx),
  ].join('\n')
}
