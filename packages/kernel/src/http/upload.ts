/**
 * The body of an upload route: the raw bytes of ONE file, written to disk by the kernel.
 *
 * A module never sees the stream (ADR-0012). It gets a path the kernel chose, inside its own state
 * directory, and a byte count. Everything that could go wrong with the bytes — too many, too few, a
 * client that leaves — is settled here, and none of it leaves a file behind (spec 2026-10-01, D2).
 *
 * `content-length` is not required. The browser sends it (measured: Chrome 154, `fetch` with a
 * `File`), but `tailscale serve` forwards a `chunked` body as `chunked`, so a length is a shortcut to
 * an early 413 and never a condition.
 */

import { randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReceivedFile } from '@factotum/core'
import { incomingDir } from '../config/paths.ts'
import { drainCapped, refuseTooLarge } from './body.ts'

/** The declared length, when there is a sane one. Node itself refuses a malformed header. */
function declaredLength(req: IncomingMessage): number | undefined {
  const raw = req.headers['content-length']
  if (raw === undefined) return undefined
  const value = Number(raw)
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

/**
 * Writes the body to `<stateDir>/.incoming/<uuid>.part` and returns it, or answers (or gives up on) the
 * request itself and returns `undefined`. The caller deletes what the handler did not keep.
 */
export async function readUploadBody(
  req: IncomingMessage,
  res: ServerResponse,
  stateDir: string,
  maxBytes: number,
): Promise<ReceivedFile | undefined> {
  const tooLarge = `this upload is capped at ${maxBytes} bytes`

  const declared = declaredLength(req)
  if (declared !== undefined && declared > maxBytes) {
    // Said before a single byte is written: nothing reaches the disk (criterion 5a).
    refuseTooLarge(res, await drainCapped(req), tooLarge)
    return undefined
  }

  const dir = incomingDir(stateDir)
  await mkdir(dir, { recursive: true })
  // Named by the kernel. Nothing from the request — not the name, not the query — forms this path.
  const path = join(dir, `${randomUUID()}.part`)

  let bytes = 0
  let over = false
  const limit = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length
      if (bytes > maxBytes) {
        over = true
        callback(new Error('too-large'))
        return
      }
      callback(null, chunk)
    },
  })

  try {
    await pipeline(req, limit, createWriteStream(path, { flags: 'wx' }))
  } catch {
    await rm(path, { force: true })
    // Over the cap without a length (`chunked`): the pipeline has already destroyed the request, so
    // this 413 may never be read — accepted, criterion 5b. Otherwise the client left: nobody to tell.
    if (over) refuseTooLarge(res, false, tooLarge)
    else if (!res.headersSent) res.destroy()
    return undefined
  }

  return { path, bytes }
}
