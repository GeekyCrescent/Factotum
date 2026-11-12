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

/** An issue of one package entry; the report adds its file and N. */
export interface EntryIssue {
  readonly kind: SeedIssueKind
  readonly detail: string
}

export interface SeedIssue extends EntryIssue {
  readonly file: string
  /** The entry's N; null for an issue of a whole file (the kit, the companies file). */
  readonly n: number | null
}
