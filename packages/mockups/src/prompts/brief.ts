/**
 * The brief (design D4; criteria 21, 22). Its STRUCTURE comes from the scope documents of the two
 * mockups made by hand (requirements §0.1) — understood, assumed with its risk, open questions,
 * functional vs. simulated, out of scope — never their content.
 */

import { join } from 'node:path'
import { closing, preamble, redoSection, type PromptContext } from './common.ts'

export function briefPrompt(ctx: PromptContext): string {
  const doc = join(ctx.vaultDir, '01-brief.md')
  return [
    preamble(ctx, 'This stage is the BRIEF: read every input and write down what the client is asking for, before anyone designs anything.'),
    ...(ctx.redo === undefined ? [] : [redoSection(ctx)]),
    '',
    '## What to write',
    '',
    `One file: ${doc}`,
    '',
    'Frontmatter: `title`, `type: mockup-brief`, `client`, `created` (today, YYYY-MM-DD) and `sources` (the input files you read).',
    '',
    'Then these sections, in this order. The first three are lists, and none of them may be empty:',
    '',
    '1. **Understood** — what the inputs say the mockup must show. Each point names its source (the file, or the note).',
    '2. **Assumed** — what you inferred and the inputs do not say. Each point with its **risk** if the assumption is wrong.',
    '3. **Open questions** — for the client, short and answerable. A document you could not read goes here.',
    '4. **Functional vs. simulated** — what the mockup should really do (navigate, fill a form, filter) and what it only pretends (integrations, payments, messages).',
    '5. **Out of scope** — what the inputs mention and this mockup will not show.',
    '',
    'A mockup is a navigable demo, not a product. For a client of BWR it is shown in a meeting to win the work; for the owner\'s own project it is a prototype to decide the design, not a sales demo. Tell which one this is from the inputs, and write for it.',
    'In «Functional vs. simulated», mark exactly ONE step as the one that sells the idea: the moment it clicks. Mark exactly ONE step, never several.',
    closing(ctx),
  ].join('\n')
}
