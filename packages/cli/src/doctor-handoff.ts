/**
 * What `doctor` says about the handoff (spec 2026-10-07-dos-hosts, criterion 35; design D13, «doctor
 * en el corte 2»), per project with an `origin`, and the handoffs that could not be undone:
 *
 *   - `git ls-remote origin`: whether the pull before a launch and the handoff's `fetch` can read it
 *     without asking anything. Nothing of the handoff writes to the remote since the v4;
 *   - the ignore rules outside the repo, against the peer's: they must match (docs/hosts.md). Asked to
 *     the peer with HANDOFF_PEER_READ_TIMEOUT_MS — it runs git in every repo — and never the 3 s of the
 *     probe, which would call a slow peer unreachable;
 *   - every journal in `abort-failed`, with what is left to undo by hand.
 *
 * NEVER THROWS, like the rest of doctor. The projects come from the registry (`readRegistry`), not from
 * `describeRegistry`, which answers a line of text.
 */

import { join } from 'node:path'
import { machineName } from '@factotum/kernel'
import { readRegistry } from '@factotum/modules'
import {
  GIT_NET_TIMEOUT_MS,
  HANDOFF_PEER_READ_TIMEOUT_MS,
  ignoreDigest,
  listHids,
  listJournals,
  remoteKey,
  runGit,
  sessionPaths,
  type IgnoreDigest,
} from '@factotum/sessions'

export interface HandoffReportDeps {
  /** The sessions module's state directory. */
  readonly stateDir: string
  readonly registry: string
  readonly peers: readonly { readonly origin: string }[]
  readonly out: (line: string) => void
  readonly fetch: typeof globalThis.fetch
  /** The environment git runs with; tests give an empty global config. */
  readonly gitEnv?: NodeJS.ProcessEnv
  /** Tests shorten it. */
  readonly peerTimeoutMs?: number
}

interface PeerProject {
  readonly key: string
  readonly ignoreDigest: IgnoreDigest
}

export async function reportHandoff(deps: HandoffReportDeps): Promise<void> {
  const read = await readRegistry(deps.registry)
  const projects = read.kind === 'ok' ? read.registry.projects : []
  const peerProjects = new Map<string, Asked>()
  for (const { origin } of deps.peers) peerProjects.set(machineName(origin), await askPeer(origin, deps))

  for (const project of projects) {
    const url = await runGit(['config', '--get', 'remote.origin.url'], 5_000, project.path, deps.gitEnv).then((out) => out.trim(), () => '')
    if (url === '') continue
    deps.out(`  handoff     ${project.id}`)
    deps.out(`              ${await describeRemote(project.path, deps.gitEnv)}`)
    const here = await ignoreDigest(project.path, deps.gitEnv).catch(() => undefined)
    for (const [peer, theirs] of peerProjects) deps.out(`              ${describeIgnore(peer, remoteKey(url), here, theirs)}`)
  }
  await reportAbortFailed(deps)
}

/** `git ls-remote origin`, without anything that could ask: the code of a failure, never its text. */
async function describeRemote(path: string, env: NodeJS.ProcessEnv | undefined): Promise<string> {
  try {
    await runGit(['ls-remote', '--quiet', 'origin', 'HEAD'], GIT_NET_TIMEOUT_MS, path, env)
    return 'reads origin without asking'
  } catch (error) {
    const timedOut = (error as { timedOut?: boolean }).timedOut === true
    return timedOut ? `CANNOT READ origin within ${GIT_NET_TIMEOUT_MS}ms` : 'CANNOT READ origin without asking — the handoff and the pull before a launch need it'
  }
}

/** The peer's projects; `old` when it answers but has no handoff routes (a factotum from before); `undefined` when it does not answer. */
type Asked = readonly PeerProject[] | 'old' | undefined

async function askPeer(origin: string, deps: HandoffReportDeps): Promise<Asked> {
  try {
    const response = await deps.fetch(new URL('/modules/sessions/handoff/projects', origin).href, {
      redirect: 'manual',
      signal: AbortSignal.timeout(deps.peerTimeoutMs ?? HANDOFF_PEER_READ_TIMEOUT_MS),
      headers: { accept: 'application/json' },
    })
    if (response.status !== 200) {
      await response.body?.cancel()
      return response.status === 404 ? 'old' : undefined
    }
    const body = (await response.json().catch(() => undefined)) as unknown
    if (!Array.isArray(body)) return undefined
    return body.flatMap((entry: { key?: unknown; ignoreDigest?: { global?: unknown; info?: unknown } }) =>
      typeof entry.key === 'string' && typeof entry.ignoreDigest?.global === 'string' && typeof entry.ignoreDigest.info === 'string'
        ? [{ key: entry.key, ignoreDigest: { global: entry.ignoreDigest.global, info: entry.ignoreDigest.info } }]
        : [],
    )
  } catch {
    return undefined
  }
}

function describeIgnore(peer: string, key: string | undefined, here: IgnoreDigest | undefined, theirs: Asked): string {
  if (theirs === undefined) return `ignore rules not compared: ${peer} unreachable`
  if (theirs === 'old') return `ignore rules not compared: ${peer} runs a factotum from before the handoff`
  const pair = theirs.find((project) => project.key === key)
  if (pair === undefined || here === undefined) return `ignore rules not compared: ${peer} has no clone of it`
  const differ = [pair.ignoreDigest.global !== here.global ? 'global' : '', pair.ignoreDigest.info !== here.info ? 'info' : ''].filter(Boolean)
  return differ.length === 0 ? `ignore rules match ${peer}` : `IGNORE RULES DIFFER from ${peer} (${differ.join(' | ')}): see docs/hosts.md`
}

/** Every `abort-failed` (design D9): what is left, and where, for the fix by hand of docs/hosts.md. */
async function reportAbortFailed(deps: HandoffReportDeps): Promise<void> {
  const paths = sessionPaths(deps.stateDir)
  for (const hid of await listHids(paths).catch(() => [] as string[])) {
    for (const journal of await listJournals(paths, hid).catch(() => [])) {
      if (journal.phase !== 'abort-failed') continue
      const steps = (journal.leftovers ?? []).map((left) => left.step).join(', ') || 'unknown'
      deps.out(`  handoff     ${hid} ${journal.siteId} ABORT-FAILED: left ${steps}`)
      deps.out(`              see docs/hosts.md; its folder: ${join(paths.handoffWork(hid, journal.siteId))}`)
    }
  }
}
