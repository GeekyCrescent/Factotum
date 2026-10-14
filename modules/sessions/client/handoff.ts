/**
 * The handoff sheet's decisions, PURE (spec 2026-10-07-dos-hosts, design D12; tasks K1): which buttons
 * each step shows, and every reason and warning of D7–D11 in plain words. What is painted is
 * `handoff-sheet.tsx`'s, checked by hand in K4; what is decided is here, with its test.
 *
 * NO «—» IN WHAT IS READ (criterion 41): these strings reach the screen.
 */

export interface PlannedView {
  readonly siteId: string
  readonly targetSiteId: string
  readonly branch: string
  readonly sessions: readonly string[]
  readonly localCommits: number
  readonly changedFiles: number
  readonly newUntracked: readonly string[]
  readonly bytes: number
  readonly warnings: readonly string[]
}

export interface SkippedView {
  readonly siteId: string
  readonly sessionId?: string
  readonly reason: string
}

export interface PlanView {
  readonly projects: readonly PlannedView[]
  readonly skipped: readonly SkippedView[]
  readonly totals: { readonly archived: number; readonly tooOld: number }
}

export type PreviewView =
  | { readonly state: 'running' }
  | { readonly state: 'ready'; readonly plan: PlanView }
  | { readonly state: 'failed'; readonly reason: string }

export interface ReportProject {
  readonly siteId: string
  readonly phase: string
  readonly sessions: readonly string[]
  readonly reason?: string
  readonly warnings: readonly string[]
  readonly stoppedServices: readonly string[]
  readonly targetReason?: string
  readonly targetWarnings: readonly string[]
  readonly targetPaths?: readonly string[]
  readonly targetPathCount?: number
}

export interface ReportView {
  readonly hid: string
  readonly peer: string
  readonly startedAt: string
  readonly state?: 'planning' | 'running' | 'finished' | 'failed'
  readonly failure?: string
  readonly skipped?: readonly SkippedView[]
  readonly totals?: { readonly archived: number; readonly tooOld: number }
  readonly projects: readonly ReportProject[]
}

export type SheetState =
  | { readonly step: 'preview'; readonly preview: PreviewView }
  | { readonly step: 'moving'; readonly report: ReportView | undefined }

export type Action = 'cancel' | 'confirm' | 'retry' | 'close' | `keep:${string}`

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

export function bytesText(bytes: number): string {
  if (bytes < 1_000) return `${bytes} B`
  if (bytes < 1_000_000) return `${Math.round(bytes / 1_000)} KB`
  return `${(bytes / 1_000_000).toFixed(1)} MB`
}

/** One line under a project that goes: sessions, the commits that travel, the changes, the size. */
export function plannedLine(project: PlannedView): string {
  const parts = [plural(project.sessions.length, 'session')]
  if (project.localCommits > 0) parts.push(`${plural(project.localCommits, 'local commit')} ${project.localCommits === 1 ? 'goes' : 'go'} with it (nothing is pushed)`)
  if (project.changedFiles > 0) parts.push(plural(project.changedFiles, 'changed file'))
  parts.push(bytesText(project.bytes))
  return parts.join(' · ')
}

/** Every reason of design D7 (the plan), D8 (the target) and the source's own. Unknown ones as they are. */
export function reasonText(reason: string, host: string, branch?: string): string {
  const texts: Readonly<Record<string, string>> = {
    running: 'It is working right now.',
    'project-busy': 'Another session of this project is working.',
    'project-not-portable': 'This project is not a git repo with an origin, so it cannot travel.',
    'ambiguous-remote': 'Two projects share this remote, on one host or the other.',
    'no-clone-on-target': `${host} has no clone of this repo.`,
    'detached-head': 'This project is not on a branch here.',
    'target-dirty': `That project has uncommitted changes on ${host}.`,
    'target-busy': `A session is working in that project on ${host}.`,
    'target-ahead': `${host} has commits on ${branch ?? 'that branch'} that this host doesn't. Pull them here first.`,
    'entry-missing-on-target': `${host} does not have the entry this session was launched with.`,
    'cli-transcript-missing': 'The CLI transcript of this session is not on this host.',
    'too-large': 'One of its files is over 256 MB.',
    'too-slow-to-send': 'One of its files would take too long to send.',
    'history-diverged': `This conversation also went on, differently, on ${host}.`,
    'code-too-large': 'The code to carry is too large to send.',
    'bundle-base-missing': `${host} lacks commits the code builds on, and could not fetch them.`,
    'head-mismatch': `${host} could not move the branch to this host's commit.`,
    'wip-apply-failed': `${host} could not apply the uncommitted changes, and undid it.`,
    'install-failed': `${host} could not install it, and undid it.`,
    'target-ignored-collision': `${host} ignores these files and has its own copy. Move them or align the ignore rules (docs/hosts.md).`,
    'abort-failed': `${host} could not undo everything: run factotum doctor there.`,
    expired: `${host} stopped waiting for this host and let it go.`,
    'not-found': `${host} had no record of this handoff.`,
    'source-changed-during-handoff': 'This project changed here during the handoff.',
    'too-many-files': 'It has too many files to send in one go.',
    'source-error': 'Something failed on this host; nothing was moved.',
    restarted: 'The daemon restarted in the middle; nothing was moved.',
    'peer-error': `${host} answered something this host could not read.`,
  }
  return texts[reason] ?? reason
}

export function warningText(code: string, host: string, hid: string): string {
  const texts: Readonly<Record<string, string>> = {
    'ignore-rules-differ': 'The two hosts ignore different files outside this repo. See docs/hosts.md.',
    'target-rescued': `Changes found on ${host} during the handoff were saved to refs/factotum/handoff-rescue/${hid}.`,
    'upload-collision': `${host} already had an attachment with the same id and other contents; it kept its own.`,
    'source-changed-during-handoff': `This project changed here during the handoff, so it was not cleaned. The work is also kept in refs/factotum/handoff-backup/${hid}.`,
  }
  return texts[code] ?? code
}

/** A preview that could not be made, and how to go on. */
export function failureText(reason: string, host: string): string {
  if (reason === 'peer-unreachable') return `${host} did not answer. Try again once it is up.`
  if (reason === 'peer-timeout') return `${host} took too long to say what it has. Try again.`
  if (reason === 'unknown-peer') return `${host} is not a peer of this host.`
  return `The preview could not be made (${reason}). Try again.`
}

export type Tone = 'moving' | 'moved' | 'stayed' | 'waiting' | 'kept'

/** The paths of a collision that came, and how many more there were. */
export function pathsOf(project: ReportProject): { readonly shown: readonly string[]; readonly more: number } {
  const shown = project.targetPaths ?? []
  return { shown, more: Math.max(0, (project.targetPathCount ?? shown.length) - shown.length) }
}

/** One project of the report: how it ended, and the notes under it. */
export function outcomeOf(project: ReportProject, host: string, hid: string): { readonly tone: Tone; readonly text: string; readonly notes: readonly string[] } {
  const notes = [
    ...(project.stoppedServices.length > 0 ? [`Stopped ${plural(project.stoppedServices.length, 'background service')} here; they do not travel.`] : []),
    ...project.warnings.map((code) => warningText(code, host, hid)),
    ...project.targetWarnings.map((code) => warningText(code, host, hid)),
  ]
  switch (project.phase) {
    case 'done':
    case 'acked':
      return { tone: 'moved', text: `${plural(project.sessions.length, 'session')} moved to ${host}`, notes }
    case 'aborted': {
      const why = project.targetReason ?? project.reason
      return { tone: 'stayed', text: `Stayed here. ${why === undefined ? '' : reasonText(why, host)}`.trim(), notes }
    }
    case 'pending-peer':
      return { tone: 'waiting', text: `Waiting for ${host} to say whether it was installed.`, notes }
    case 'kept':
      return { tone: 'kept', text: 'Kept here.', notes }
    default:
      return { tone: 'moving', text: 'On its way…', notes }
  }
}

const UNDERWAY: ReadonlySet<string> = new Set(['locking', 'locked', 'sending', 'committing', 'acked'])

/** Over: the run finished or failed, and no project is still on its way. A pending-peer waits on the owner. */
export function isSettled(report: ReportView): boolean {
  if (report.state === 'planning' || report.state === 'running') return false
  return !report.projects.some((project) => UNDERWAY.has(project.phase))
}

export function actionsFor(state: SheetState): readonly Action[] {
  if (state.step === 'preview') {
    if (state.preview.state === 'failed') return ['cancel', 'retry']
    if (state.preview.state === 'ready' && state.preview.plan.projects.length > 0) return ['cancel', 'confirm']
    return ['cancel']
  }
  if (state.report === undefined || !isSettled(state.report)) return []
  const keeps = state.report.projects.filter((project) => project.phase === 'pending-peer').map((project): Action => `keep:${project.siteId}`)
  return ['close', ...keeps]
}
