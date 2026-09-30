/**
 * Serving a file a module named in its response (`ModuleResponse.file`, ADR-0012).
 *
 * THE KERNEL DECIDES HOW, NOT THE MODULE. What is served comes from the origin that approves
 * permissions, so a file that the browser would run — HTML, SVG — is the one thing that must never
 * be painted. The type comes from the file's first bytes; only four raster formats are `inline`;
 * everything else is a download, sandboxed and never sniffed (spec 2026-10-01, D3).
 *
 * And only from the module's own directory, checked on the descriptor that is actually open.
 */

import { constants, createReadStream } from 'node:fs'
import { open, realpath, stat, type FileHandle } from 'node:fs/promises'
import type { ServerResponse } from 'node:http'
import { isAbsolute, normalize, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { errorBody, rasterTypeOf, SNIFF_BYTES } from '@factotum/core'

/** Headers every served file carries, whatever it is. */
const ALWAYS: Readonly<Record<string, string>> = {
  'x-content-type-options': 'nosniff',
  // `sandbox` with no allowances: opened directly, the document gets a unique origin and no scripts.
  'content-security-policy': "default-src 'none'; sandbox",
  // A thumbnail kept on the phone's disk would outlive the conversation it belonged to.
  'cache-control': 'no-store',
}

/** Injected so a test can swap the file between the `open` and the check (criterion 8a). */
export interface ServeFileDeps {
  readonly realpath: (path: string) => Promise<string>
}

const realDeps: ServeFileDeps = { realpath: async (path) => await realpath(path) }

/** Is `target` inside `root`, WITH the separator — `/a/bc` is not inside `/a/b`. */
function contains(root: string, target: string): boolean {
  const cleanRoot = normalize(root).replace(/[/\\]+$/, '')
  const cleanTarget = normalize(target)
  return cleanTarget.startsWith(cleanRoot + sep)
}

function notFound(res: ServerResponse): void {
  if (res.headersSent) return void res.destroy()
  res.writeHead(404, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(errorBody('not-found', 'there is no such file')))
}

export async function sendFile(res: ServerResponse, file: string, stateDir: string, deps: ServeFileDeps = realDeps): Promise<void> {
  // Never resolved against the daemon's working directory.
  if (!isAbsolute(file)) return notFound(res)

  let handle: FileHandle
  try {
    // O_NOFOLLOW: a symlink in the LAST component fails here, whatever it points at.
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch {
    return notFound(res)
  }

  let streaming = false
  try {
    const opened = await handle.stat()
    if (!opened.isFile()) return notFound(res)

    // The path, resolved, inside the module's directory — AND naming the very inode that is open. The
    // second half is what makes the check about the descriptor and not about a path that could have
    // changed between the `open` above and the `realpath` here.
    let real: string
    let root: string
    try {
      real = await deps.realpath(file)
      root = await deps.realpath(stateDir)
    } catch {
      return notFound(res)
    }
    if (!contains(root, real)) return notFound(res)
    const named = await stat(real).catch(() => undefined)
    if (named === undefined || named.dev !== opened.dev || named.ino !== opened.ino) return notFound(res)

    const head = Buffer.alloc(SNIFF_BYTES)
    const { bytesRead } = await handle.read(head, 0, SNIFF_BYTES, 0)
    const raster = rasterTypeOf(head.subarray(0, bytesRead))

    res.writeHead(200, {
      ...ALWAYS,
      'content-length': String(opened.size),
      ...(raster !== undefined
        ? { 'content-type': raster }
        : { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment' }),
    })
    streaming = true
    // The stream owns the descriptor from here and closes it when it ends or fails.
    await pipeline(createReadStream('', { fd: handle, start: 0, autoClose: true }), res).catch(() => {
      res.destroy()
    })
  } finally {
    if (!streaming) await handle.close().catch(() => undefined)
  }
}
