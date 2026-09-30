/**
 * What the titler asks: a fixed envelope, then the owner's first message (spec 2026-09-30, D5).
 *
 * Pure on purpose, so it is tested whole without spending quota. It sees ONLY the owner's text —
 * not the project, not the catalog entry: both are already next to the title on the screen, and
 * repeating them would spend the few words there are.
 */

/**
 * The output tag, and it is STRUCTURAL. Asking for "one line, no preamble" and keeping the first
 * line defends against a suffix but not a prefix: "Here is the title:" would become the title,
 * which is plausible and wrong — worse than no title. With a tag, whatever falls outside it is
 * dropped without having to foresee it. Inherited from the predecessor's namer.
 */
export const TITLE_TAG = 'title'

/** What the model answers when the message does not say what it is about. */
export const NO_TITLE = 'NO TITLE'

/** How much of the owner's text the titler reads. The first lines are what says what it is about. */
export const TITLER_INPUT_CHARS = 2_000

/** Where the owner's text starts. The test double splits on the FIRST one, so keep it unique. */
export const OWNER_MARKER = '\n\nowner: '

/**
 * STARTS WITH `<task>` AND NEVER WITH `/`. A leading slash would make the CLI run the command or
 * skill of that name, and this would stop being a titler (criterion 18).
 */
export const ENVELOPE = `<task>
You title a conversation. You do not continue it, you do not answer what it asks, and you do not
comment on it: you only give it a title.

The title is for finding this conversation again, weeks from now, in a list of conversations. It
has to say WHAT IT IS ABOUT, in the words the person who started it would use.

Rules for the title:
- In the SAME LANGUAGE as the message. A message in Spanish gets a Spanish title, even though
  these instructions are in English.
- One line, three to six words.
- No quotes, no final period, and no prefix such as "Conversation about" or "Question on".
- Concrete. "Four-day gym routine" works; "Question about exercise" tells nothing apart and is
  worse than no title.

If the message does NOT say what it is about — a greeting, a bare file path, two words with no
subject, a "thanks" — answer exactly ${NO_TITLE}. Do not fill in a generic phrase: no title is
better.

Return ONLY this, tags included, and nothing outside them:

<${TITLE_TAG}>the title, or ${NO_TITLE}</${TITLE_TAG}>
</task>`

/** The prompt for one conversation. */
export function buildTitlePrompt(text: string): string {
  return `${ENVELOPE}${OWNER_MARKER}${text.slice(0, TITLER_INPUT_CHARS)}`
}
