/**
 * What each host's projects look like through git, for the plan (spec 2026-10-07-dos-hosts, D7).
 *
 * READ ONLY, and it has to be: the preview changes nothing on either host (criterion 23). No
 * `fetch` — the source's HEAD does not change with one, so the answer would not either — and every
 * command runs with `GIT_OPTIONAL_LOCKS=0`, so `status` does not even refresh the owner's index.
 */

import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import { isSessionId } from '../id.ts'
import { handoffGit, handoffGitSucceeds, ignoreDigest, remoteKey, type IgnoreDigest } from './git.ts'
import { sessionFiles, type LocalFile } from './files.ts'
import type { HandoffHost } from './host.ts'
import { extendsLog, logDigest, type LogDigest } from './log-digest.ts'
import { isCandidate, pairOf, type PlanFacts, type PlanProject, type PlanSession, type TargetProject } from './plan.ts'

export interface ProjectGit {
  readonly key: string | undefined
  readonly branch: string | undefined
  readonly head: string | undefined
  readonly clean: boolean
  readonly changedFiles: number
  readonly newUntracked: readonly string[]
  readonly localCommits: number
  readonly heads: Readonly<Record<string, string>>
  readonly ignoreDigest: IgnoreDigest
}

/** One project through git, or `undefined` when it is not a repo with a commit. */
export async function projectGit(path: string, env?: NodeJS.ProcessEnv): Promise<ProjectGit | undefined> {
  const options = env !== undefined ? { base: env } : {}
  const git = (args: readonly string[]) => handoffGit(path, args, options)
  const head = await git(['rev-parse', '--verify', '-q', 'HEAD']).then((out) => out.trim(), () => undefined)
  if (head === undefined) return undefined
  const url = await git(['config', '--get', 'remote.origin.url']).then((out) => out.trim(), () => '')
  const branch = await git(['symbolic-ref', '-q', '--short', 'HEAD']).then((out) => out.trim(), () => undefined)
  const status = parseStatus(await git(['status', '--porcelain=v1', '-z', '--untracked-files=all']))
  const localCommits = url === '' ? 0 : Number.parseInt((await git(['rev-list', '--count', 'HEAD', '--not', '--remotes=origin'])).trim(), 10)
  const heads: Record<string, string> = {}
  for (const line of (await git(['for-each-ref', '--format=%(refname:short) %(objectname)', 'refs/heads'])).split('\n')) {
    const at = line.lastIndexOf(' ')
    if (at > 0) heads[line.slice(0, at)] = line.slice(at + 1)
  }
  return {
    key: remoteKey(url),
    branch: branch === '' ? undefined : branch,
    head,
    clean: status.length === 0,
    changedFiles: status.length,
    newUntracked: status.filter((entry) => entry.code === '??').map((entry) => entry.path),
    localCommits,
    heads,
    ignoreDigest: await ignoreDigest(path, env),
  }
}

/** `status --porcelain=v1 -z`: a rename or a copy carries its old path as one more field. */
function parseStatus(raw: string): readonly { readonly code: string; readonly path: string }[] {
  const fields = raw.split('\0')
  const out: { code: string; path: string }[] = []
  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i] ?? ''
    if (field.length < 4) continue
    const code = field.slice(0, 2)
    out.push({ code, path: field.slice(3) })
    if (code[0] === 'R' || code[0] === 'C') i += 1
  }
  return out
}

export interface SourceSnapshot {
  readonly projects: readonly PlanProject[]
  /** Every file of every candidate, for the manifest. */
  readonly files: ReadonlyMap<string, readonly LocalFile[]>
}

/** This host as the SOURCE: its projects, their sessions, and what each candidate would send. */
export async function sourceSnapshot(host: HandoffHost, now: Date): Promise<SourceSnapshot> {
  const projects: PlanProject[] = []
  const files = new Map<string, readonly LocalFile[]>()
  for (const { id, path } of host.projects()) {
    const metas = host.sessionsOf(id)
    if (metas.length === 0) continue
    const git = await projectGit(path, host.gitEnv)
    const holders = (await host.locks.holders(id)).length
    const sessions: PlanSession[] = []
    for (const meta of metas) {
      if (!isCandidate(meta, now) || meta.state === 'running') {
        sessions.push({ meta, fileBytes: [], transcriptFound: false })
        continue
      }
      const inventory = await sessionFiles(host, meta.id)
      files.set(meta.id, inventory.files)
      sessions.push({ meta, fileBytes: inventory.files.map((file) => file.bytes), transcriptFound: inventory.transcriptFound })
    }
    projects.push({
      siteId: id,
      key: git?.key,
      branch: git?.branch,
      head: git?.head,
      busy: holders > 0 || metas.some((meta) => meta.state === 'running'),
      localCommits: git?.localCommits ?? 0,
      changedFiles: git?.changedFiles ?? 0,
      newUntracked: git?.newUntracked ?? [],
      ignoreDigest: git?.ignoreDigest,
      sessions,
    })
  }
  return { projects, files }
}

/** This host as the TARGET: what `GET handoff/projects` answers. Only portable projects. */
export async function targetProjects(host: HandoffHost): Promise<readonly TargetProject[]> {
  const out: TargetProject[] = []
  const entries = host.entries()
  for (const { id, path } of host.projects()) {
    const git = await projectGit(path, host.gitEnv)
    if (git === undefined || git.key === undefined) continue
    out.push({
      key: git.key,
      siteId: id,
      clean: git.clean,
      busy: (await host.locks.holders(id)).length > 0,
      branch: git.branch,
      head: git.head,
      heads: git.heads,
      entries,
      ignoreDigest: git.ignoreDigest,
    })
  }
  return out
}

/** What the peer said, checked like any input from outside. */
export const targetProjectsSchema = z.array(
  z.object({
    key: z.string().min(1),
    siteId: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    clean: z.boolean(),
    busy: z.boolean(),
    branch: z.string().optional(),
    head: z.string().optional(),
    // Tips that reach a git command line: hashes, and nothing that could read as an option.
    heads: z.record(z.string(), z.string().regex(/^[0-9a-f]{40,64}$/)),
    entries: z.array(z.string()),
    ignoreDigest: z.object({ global: z.string(), info: z.string() }),
  }),
)

export const sessionsCheckSchema = z.array(z.object({ id: z.string(), lines: z.number().int().min(0), sha256: z.string() }))
export type RemoteLog = { readonly id: string } & LogDigest

/** `POST handoff/sessions-check`, on the target: the digest of every asked session this host has. */
export async function sessionsCheck(host: Pick<HandoffHost, 'paths'>, ids: readonly unknown[]): Promise<readonly RemoteLog[]> {
  const out: RemoteLog[] = []
  for (const id of ids) {
    if (typeof id !== 'string' || !isSessionId(id)) continue
    const text = await readFile(host.paths.eventsFile(id), 'utf8').catch(() => undefined)
    if (text !== undefined) out.push({ id, ...logDigest(text) })
  }
  return out
}

/**
 * The sessions whose log here does not extend the target's: `history-diverged` (D7). THE one
 * comparison, used by the preview and by the source's step 4 (J8).
 */
export async function divergedOf(host: Pick<HandoffHost, 'paths'>, remote: readonly RemoteLog[]): Promise<ReadonlySet<string>> {
  const diverged = new Set<string>()
  for (const log of remote) {
    if (!isSessionId(log.id)) continue
    const text = await readFile(host.paths.eventsFile(log.id), 'utf8').catch(() => '')
    if (!extendsLog(text, log)) diverged.add(log.id)
  }
  return diverged
}

/** For each paired project whose target has its branch: is that tip this HEAD or an ancestor of it? */
export async function ancestryOf(host: Pick<HandoffHost, 'projects' | 'gitEnv'>, projects: readonly PlanProject[], targets: readonly TargetProject[]): Promise<ReadonlyMap<string, boolean>> {
  const paths = new Map(host.projects().map((p) => [p.id, p.path]))
  const out = new Map<string, boolean>()
  for (const project of projects) {
    const pair = pairOf(project, projects, targets)
    const tip = typeof pair === 'string' || project.branch === undefined || !Object.hasOwn(pair.heads, project.branch) ? undefined : pair.heads[project.branch]
    const path = paths.get(project.siteId)
    if (tip === undefined || path === undefined || !/^[0-9a-f]{40,64}$/.test(tip)) continue
    // A tip this host does not have is not an ancestor: exit 128 reads as `false`.
    out.set(project.siteId, await handoffGitSucceeds(path, ['merge-base', '--is-ancestor', tip, 'HEAD'], host.gitEnv !== undefined ? { base: host.gitEnv } : {}))
  }
  return out
}

/** The candidate sessions of the projects that pair with a target project: the ones to ask about. */
export function pairedCandidates(projects: readonly PlanProject[], targets: readonly TargetProject[], now: Date): readonly string[] {
  return projects
    .filter((project) => typeof pairOf(project, projects, targets) !== 'string')
    .flatMap((project) => project.sessions.filter((one) => isCandidate(one.meta, now)).map((one) => one.meta.id))
}

export type { PlanFacts }
