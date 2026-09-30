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
import { errorBody, type ReceivedFile } from '@factotum/core'
import { incomingDir } from '../config/paths.ts'
import { drainCapped, refuseTooLarge } from './body.ts'

/**
 * A write that failed on OUR side (no space, no permission): said on stderr, never silent, and a 500
 * when there is still a request to answer. When the pipeline already destroyed the request there is
 * not — draining a dead stream is what once made a 413 take six seconds — so the socket just goes.
 */
async function failWrite(req: IncomingMessage, res: ServerResponse, error: unknown): Promise<undefined> {
  const code = (error as NodeJS.ErrnoException | undefined)?.code ?? 'unknown'
  console.error(`[kernel] an upload could not be written: ${code}`)
  if (req.destroyed) {
    res.destroy()
    return undefined
  }
  const drained = req.complete || (await drainCapped(req))
  if (!res.headersSent && !res.destroyed) {
    res.writeHead(500, drained ? { 'content-type': 'application/json' } : { 'content-type': 'application/json', connection: 'close' })
    res.end(JSON.stringify(errorBody('module-error', 'the upload could not be written on the host')))
  }
  return undefined
}

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
  try {
    await mkdir(dir, { recursive: true })
  } catch (error) {
    return failWrite(req, res, error)
  }
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

  // Told apart by WHICH STREAM failed, not by the request's state: the pipeline destroys every
  // stream in it whichever one failed, so a dead request says nothing about who hung up.
  const sink = createWriteStream(path, { flags: 'wx' })
  let diskError: unknown
  sink.once('error', (error) => (diskError = error))

  try {
    await pipeline(req, limit, sink)
  } catch {
    await rm(path, { force: true })
    // Over the cap without a length (`chunked`): the pipeline has already destroyed the request, so
    // this 413 may never be read — accepted, criterion 5b.
    if (over) refuseTooLarge(res, false, tooLarge)
    // The disk failed: ours, and it must not pass for the client hanging up.
    else if (diskError !== undefined) await failWrite(req, res, diskError)
    // The client left: nobody to tell.
    else if (!res.headersSent) res.destroy()
    return undefined
  }

  return { path, bytes }
}
