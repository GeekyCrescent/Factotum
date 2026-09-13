/** A module's entry in the client's navigation. */

export interface NavEntry {
  readonly label: string
  /**
   * Free-form, NOT a closed union.
   *
   * A closed union in this package would mean that adding a module requires editing
   * the kernel — which is the exact failure this project exists to correct. The
   * client resolves the names it knows and falls back to a generic glyph.
   */
  readonly icon: string
  /** Lower sorts first. Without it, modules sort by id. */
  readonly order?: number
}
