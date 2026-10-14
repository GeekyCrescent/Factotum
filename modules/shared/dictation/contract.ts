/**
 * What the dictation needs of an api, declared HERE, structurally (design D10): two members. The
 * sessions module's `Api` and the shell's `ModuleApi` both fit it unchanged, so whoever mounts the
 * microphone hands in its own api — the dictation calls whatever host and module that api points at.
 *
 * Types only, and nothing imported from any module (criterion 44). `Blob` is the web-standard global
 * that `@types/node` declares too, so `modules/` still type-checks without `lib: ["dom"]`.
 */

export interface Api {
  readonly get: <T>(path: string) => Promise<T>
  /** The raw bytes of one file to one of the module's upload routes, the name in the query. */
  readonly upload: <T>(path: string, file: Blob, query: Readonly<Record<string, string>>) => Promise<T>
}
