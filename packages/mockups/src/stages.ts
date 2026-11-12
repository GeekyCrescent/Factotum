/**
 * The stage table (design D2): THE ONLY SOURCE of what each stage runs on, writes, offers and asks.
 *
 * `ops.ts`, `submit.ts` and the prompts read it; none of them restates a row (CLAUDE.md §0: a rule
 * written in two places drifts).
 */

import type { RunKind, StageId } from './types.ts'

export interface OptionRule {
  readonly min: number
  readonly max: number
  /** Each option must carry the URL of its preview (plan's directions). */
  readonly url: boolean
}

export interface RunSpec {
  /** `docs`: the session runs on `docsSiteId`; `work`: on the mockup's work-dir project. */
  readonly site: 'docs' | 'work'
  /** Relative to `vaultDir`: what the submission must name, exist and not be empty (D3, check 3). */
  readonly files: readonly string[]
  /** Relative to `workDir`: the same, for what a stage builds there (the app, crit. 32). */
  readonly workFiles?: readonly string[]
  readonly options: OptionRule | null
  readonly gate: 'approve' | 'choose' | null
  /** It publishes from the work-dir: the real-data guard runs before it is accepted (D3, check 6). */
  readonly guard: boolean
  /** Folders of the work-dir the stage writes, copied to `<dir>/_versions/v<k>/` before a redo (D7). */
  readonly versionedDirs?: readonly string[]
  /** The Vercel project it deploys to, `<project>-<deploysTo>` (D4); its URLs must be that project's (check 5). */
  readonly deploysTo?: 'directions' | 'mockup'
  /** The URL the run must hand in, and the only one it may (D3, check 5): a preview, or production. */
  readonly hands?: 'previewUrl' | 'prodUrl'
}

export interface StageSpec extends RunSpec {
  readonly id: StageId
  readonly next: StageId | null
  /** A choosing stage: the one of its documents that takes `chosen: <id>` (D6, criterion 28). */
  readonly chosenIn?: string
}

/** The app's folder in the work-dir (crit. 32), and the file that proves a build made one. */
export const APP_DIR = 'mockup-app'
const APP_MANIFEST = `${APP_DIR}/package.json`

export const STAGES: Readonly<Record<StageId, StageSpec>> = {
  brief: { id: 'brief', site: 'docs', files: ['01-brief.md'], options: null, gate: 'approve', guard: false, next: 'concepts' },
  concepts: { id: 'concepts', site: 'docs', files: ['02-concepts.md'], options: { min: 2, max: 3, url: false }, gate: 'choose', guard: false, next: 'plan', chosenIn: '02-concepts.md' },
  plan: {
    id: 'plan',
    site: 'docs',
    files: ['03-story-and-pages.md', '04-data.md', '05-visual-direction.md'],
    options: { min: 2, max: 3, url: true },
    gate: 'choose',
    guard: true,
    versionedDirs: ['directions'],
    deploysTo: 'directions',
    next: 'build',
    chosenIn: '05-visual-direction.md',
  },
  build: { id: 'build', site: 'work', files: [], workFiles: [APP_MANIFEST], options: null, gate: 'approve', guard: true, deploysTo: 'mockup', hands: 'previewUrl', next: 'deliver' },
  deliver: { id: 'deliver', site: 'work', files: ['06-presenter-guide.md'], options: null, gate: null, guard: true, deploysTo: 'mockup', hands: 'prodUrl', next: null },
}

/** Every kind of run: the stages, and the two of the changes track (not stages, D2). */
export const RUN_SPECS: Readonly<Record<RunKind, RunSpec>> = {
  ...STAGES,
  change: { site: 'work', files: [], workFiles: [APP_MANIFEST], options: null, gate: 'approve', guard: true, deploysTo: 'mockup', hands: 'previewUrl' },
  redeploy: { site: 'work', files: ['changes.md'], options: null, gate: null, guard: true, deploysTo: 'mockup', hands: 'prodUrl' },
}

/** The Vercel project a run of `kind` deploys to, from the vault project's slug; `null` if it deploys nothing. */
export function vercelProjectOf(project: string, kind: RunKind): string | null {
  const to = RUN_SPECS[kind].deploysTo
  return to === undefined ? null : `${project}-${to}`
}

export function nextStage(id: StageId): StageId | null {
  return STAGES[id].next
}

/** The stage whose approval opens `id`, if any. */
export function previousStage(id: StageId): StageId | null {
  return (Object.values(STAGES).find((spec) => spec.next === id)?.id ?? null)
}

/** What THIS cut launches (tasks.md: cut 1 is brief, cut 2 adds concepts and plan, cut 3 the rest by block). The rest answers `not-yet`. */
export const CUT_KINDS: readonly RunKind[] = ['brief', 'concepts', 'plan', 'build', 'deliver', 'change', 'redeploy']

export function isLaunchable(kind: RunKind): boolean {
  return CUT_KINDS.includes(kind)
}
