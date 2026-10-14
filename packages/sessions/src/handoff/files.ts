/**
 * What travels for one session, as files on this disk (spec 2026-10-07-dos-hosts, D8): its meta and
 * its log, the uploads its OWNER sent, and the CLI's transcript with its folder. The plan reads their
 * sizes; the manifest hashes them and the source sends them. One inventory for both, so what the
 * preview promised is what goes.
 */

import { lstat, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseLog } from '../events.ts'
import { isSessionId } from '../id.ts'
import { ownerUploadIds } from '../uploads/refs.ts'
import { isSanitizedName } from '../uploads/name.ts'
import { findTranscript, transcriptFiles } from './cli-paths.ts'
import type { HandoffHost } from './host.ts'

export type FileKind = 'meta' | 'events' | 'upload' | 'transcript' | 'transcript-dir-file' | 'git-bundle'

export interface LocalFile {
  /** `undefined` only for the project's `git-bundle`. */
  readonly sessionId: string | undefined
  readonly kind: FileKind
  /** Where it lands under `staging/<sessionId>/` on the target (D8, the fixed shapes). */
  readonly rel: string
  /** Where it is HERE. Never sent: the target never learns a path of this host. */
  readonly abs: string
  readonly bytes: number
}

export interface SessionFiles {
  readonly files: readonly LocalFile[]
  readonly transcriptFound: boolean
}

type FilesHost = Pick<HandoffHost, 'paths' | 'uploadsRoot' | 'claudeProjects'>

export async function sessionFiles(host: FilesHost, sessionId: string): Promise<SessionFiles> {
  const meta = host.paths.metaFile(sessionId)
  const events = host.paths.eventsFile(sessionId)
  const files: LocalFile[] = [
    { sessionId, kind: 'meta', rel: 'session/meta.json', abs: meta, bytes: await sizeOf(meta) },
    { sessionId, kind: 'events', rel: 'session/events.jsonl', abs: events, bytes: await sizeOf(events) },
  ]
  const log = parseLog(await readFile(events, 'utf8').catch(() => ''))
  for (const uploadId of ownerUploadIds(log, host.uploadsRoot)) {
    if (!isSessionId(uploadId)) continue
    const dir = join(host.uploadsRoot, uploadId)
    // A link where the upload's folder should be is not followed, as `store.remove` does not.
    if ((await lstat(dir).catch(() => undefined))?.isDirectory() !== true) continue
    for (const name of await readdir(dir)) {
      const abs = join(dir, name)
      const stat = await lstat(abs)
      if (stat.isFile() && isSanitizedName(name)) files.push({ sessionId, kind: 'upload', rel: `uploads/${uploadId}/${name}`, abs, bytes: stat.size })
    }
  }
  const found = await findTranscript(host.claudeProjects, sessionId)
  if (found === undefined) return { files, transcriptFound: false }
  for (const file of await transcriptFiles(found)) {
    const isMain = file.rel === `${sessionId}.jsonl`
    files.push({ sessionId, kind: isMain ? 'transcript' : 'transcript-dir-file', rel: `cli/${file.rel}`, abs: file.abs, bytes: file.bytes })
  }
  return { files, transcriptFound: true }
}

async function sizeOf(path: string): Promise<number> {
  return (await lstat(path).catch(() => undefined))?.size ?? 0
}
