/**
 * Where attached files live: `uploads/<uploadId>/<name>`, beside `sessions/` (spec 2026-10-01, D5).
 *
 * The kernel has already written the bytes, capped, under `.incoming/` in the same state directory.
 * Keeping one is a `rename` on the same disk — atomic — so an upload only ever has a name once it is
 * whole. Nothing here reads a body, and nothing here is handed a path that came from the network:
 * the id is made here and the name is sanitised to a closed alphabet first.
 */

import { lstat, mkdir, open, realpath, rename, rm, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { rasterTypeOf, SNIFF_BYTES, type Logger, type ReceivedFile } from '@factotum/core'
import { isSessionId, uuidv7 } from '../id.ts'
import type { UploadLookup, UploadResult, UploadsView } from '../types.ts'
import { isSanitizedName, sanitizeName } from './name.ts'

export interface UploadStore {
  readonly root: string
  readonly view: UploadsView
  readonly adopt: (file: ReceivedFile, rawName: string) => Promise<UploadResult>
  readonly locate: (uploadId: string, name: string) => UploadLookup
  /** Deletes these uploads. NEVER THROWS: a failure is a warning, because the caller already deleted. */
  readonly forget: (uploadIds: readonly string[]) => Promise<void>
}

export interface UploadStoreDeps {
  readonly root: string
  readonly maxBytes: number
  readonly now: () => Date
  readonly log: Logger
}

/**
 * The characters a root may have and still work inside `@<path>`. A home folder with a space breaks
 * the reference in two, and nobody has measured how the CLI reads a quoted one — so such a host
 * does not take files, and says why (D8).
 */
const REFERABLE = /^[A-Za-z0-9._/-]+$/

export function createUploadStore(deps: UploadStoreDeps): UploadStore {
  const { root, log } = deps
  const view: UploadsView = REFERABLE.test(root)
    ? { maxBytes: deps.maxBytes }
    : { off: `this host's state folder has characters a file reference cannot carry: ${root}` }
  if ('off' in view) log.warn(`uploads are off: ${view.off}`)

  /** Never fatal: a file kept but not sniffed is a file, not a failed upload. */
  async function isImage(path: string): Promise<boolean> {
    try {
      const handle = await open(path, 'r')
      try {
        const head = Buffer.alloc(SNIFF_BYTES)
        const { bytesRead } = await handle.read(head, 0, SNIFF_BYTES, 0)
        return rasterTypeOf(head.subarray(0, bytesRead)) !== undefined
      } finally {
        await handle.close()
      }
    } catch {
      return false
    }
  }

  return {
    root,
    view,

    adopt: async (file, rawName) => {
      if ('off' in view) return { outcome: 'off', reason: view.off }
      const sanitized = sanitizeName(rawName)
      if (!sanitized.ok) return { outcome: 'invalid', reason: sanitized.reason }
      const uploadId = uuidv7(deps.now().getTime())
      const folder = join(root, uploadId)
      const path = join(folder, sanitized.name)
      try {
        await mkdir(folder, { recursive: true })
        await rename(file.path, path)
      } catch (error) {
        // No empty `uploads/<id>/` left behind; the kernel deletes the received file.
        await rm(folder, { recursive: true, force: true })
        throw error
      }
      return { outcome: 'ok', uploadId, name: sanitized.name, path, bytes: file.bytes, image: await isImage(path) }
    },

    locate: (uploadId, name) =>
      isSessionId(uploadId) && isSanitizedName(name) ? { kind: 'ok', path: join(root, uploadId, name) } : { kind: 'invalid' },

    forget: async (uploadIds) => {
      for (const uploadId of uploadIds) {
        // Checked HERE too, whoever calls: the id becomes a path under `uploads/` and is deleted.
        if (!isSessionId(uploadId)) continue
        const folder = join(root, uploadId)
        try {
          const info = await lstat(folder)
          if (info.isSymbolicLink()) {
            // The link's own entry, which lives in `uploads/`; what it points at is not touched.
            await unlink(folder)
            continue
          }
          // The same belt as `store.remove`: nothing is deleted whose real parent is not the real root.
          if (dirname(await realpath(folder)) !== (await realpath(root))) continue
          await rm(folder, { recursive: true, force: true })
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
          log.warn(`could not delete upload ${uploadId}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    },
  }
}
