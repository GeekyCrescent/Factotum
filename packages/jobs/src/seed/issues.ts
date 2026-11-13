/**
 * What the seed parsers and the import could not take as written: never dropped silently, always in
 * the report (`ImportReport.issues`), so the owner sees it in the dry run.
 */

export type SeedIssueKind =
  /** A line of `**Likely form questions**` that is not `- *Question?* — answer`. */
  | 'unparsed-form-line'
  /** A form question with no answer: stored with `ok: false`. */
  | 'empty-answer'
  /** An address the `create` transition refuses: stored as text, without a state (approving it is `no-address`). */
  | 'invalid-address'
  /** A bold label of the kit with no blockquote answer under it (`n` = its section). */
  | 'kit-label-without-answer'
  /** A kit section number used twice: the first wins (`n` = the number). */
  | 'kit-duplicate-section'
  /** A `contact` of the companies file that is not an email address: no contact is made of it. */
  | 'contact-not-email'
  /** A company listed twice in the companies file (same `nameKey`): the first wins. */
  | 'duplicate-company'

/** An issue of one package entry; the report adds its file and N. */
export interface EntryIssue {
  readonly kind: SeedIssueKind
  readonly detail: string
}

export interface SeedIssue extends EntryIssue {
  readonly file: string
  /** The entry's N (the kit's section for a kit issue); null for an issue of a whole file. */
  readonly n: number | null
}
