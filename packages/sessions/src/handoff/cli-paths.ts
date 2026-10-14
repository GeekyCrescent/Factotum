/**
 * Where the CLI keeps a conversation (spec 2026-10-07-dos-hosts, D8; measured in A4, tasks §M).
 *
 * `~/.claude/projects/<cliDir(path)>/<id>.jsonl`, and next to it a folder `<id>/` with `subagents/`
 * and `tool-results/`. `--resume <id>` finds the file by its id in ANY folder, so on the source it is
 * SEARCHED, the most recent copy winning; on the target it goes where the CLI would put it for this
 * host's path, which is the rule A4 measured on both machines: every character outside
 * `[A-Za-z0-9]` becomes `-`, over the REAL path (`/tmp` is `/private/tmp` on the Mac).
 */

import { lstat, readdir, realpath } from 'node:fs/promises'
import { join, relative } from 'node:path'

export function cliDirName(realPath: string): string {
  return realPath.replace(/[^A-Za-z0-9]/g, '-')
}

export async function cliDirOf(path: string): Promise<string> {
  return cliDirName(await realpath(path))
}

export interface FoundTranscript {
  /** The folder of `~/.claude/projects` it was found in. */
  readonly folder: string
  readonly file: string
  /** `<folder>/<id>/`, when it exists. */
  readonly dir: string | undefined
  readonly mtimeMs: number
}

/** Every copy of `<id>.jsonl` under `projectsRoot`, in any folder. */
export async function findTranscripts(projectsRoot: string, id: string): Promise<readonly FoundTranscript[]> {
  const folders = await readdir(projectsRoot, { withFileTypes: true }).catch(() => [])
  const found: FoundTranscript[] = []
  for (const entry of folders) {
    if (!entry.isDirectory()) continue
    const folder = join(projectsRoot, entry.name)
    const file = join(folder, `${id}.jsonl`)
    const stat = await lstat(file).catch(() => undefined)
    if (stat === undefined || !stat.isFile()) continue
    const dirStat = await lstat(join(folder, id)).catch(() => undefined)
    found.push({ folder, file, dir: dirStat?.isDirectory() === true ? join(folder, id) : undefined, mtimeMs: stat.mtimeMs })
  }
  return found
}

/** The copy `--resume` would most likely use: the most recent. */
export async function findTranscript(projectsRoot: string, id: string): Promise<FoundTranscript | undefined> {
  const all = await findTranscripts(projectsRoot, id)
  return [...all].sort((a, b) => b.mtimeMs - a.mtimeMs)[0]
}

export interface TranscriptFile {
  readonly abs: string
  /** `<id>.jsonl`, or `<id>/<…>` for a file of its folder. */
  readonly rel: string
  readonly bytes: number
}

/** The jsonl and every regular file of its folder. A link is never followed: it is not the CLI's. */
export async function transcriptFiles(found: FoundTranscript): Promise<readonly TranscriptFile[]> {
  const head = await lstat(found.file)
  const out: TranscriptFile[] = [{ abs: found.file, rel: relative(found.folder, found.file), bytes: head.size }]
  if (found.dir === undefined) return out
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name)
      if (entry.isDirectory()) await walk(abs)
      else if (entry.isFile()) out.push({ abs, rel: relative(found.folder, abs), bytes: (await lstat(abs)).size })
    }
  }
  await walk(found.dir)
  return out
}
