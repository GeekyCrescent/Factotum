/**
 * What happens to a body the kernel has already said no to. Shared by the JSON branch and the upload
 * branch, because the cap on draining is one of the things that must not be decided twice.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { DRAIN_MAX_BYTES, errorBody } from '@factotum/core'

/**
 * Reads what is left of a refused body, but NEVER MORE THAN DRAIN_MAX_BYTES. `true` when it reached
 * the end — the client is then listening for the answer. `false` when it gave up: leaving the loop
 * early destroys the request, so the answer may never arrive. That is accepted (spec 2026-10-01,
 * criterion 6): what matters is that the daemon stops reading, not that the refusal is read.
 */
export async function drainCapped(req: IncomingMessage): Promise<boolean> {
  let size = 0
  try {
    for await (const chunk of req) {
      size += (chunk as Buffer).length
      if (size > DRAIN_MAX_BYTES) return false
    }
    return true
  } catch {
    // The client went away; nothing to do.
    return false
  }
}

/** 413, closing the connection when the body was not read to its end. */
export function refuseTooLarge(res: ServerResponse, drained: boolean, message: string): void {
  if (res.headersSent || res.destroyed) return
  res.writeHead(413, drained ? { 'content-type': 'application/json' } : { 'content-type': 'application/json', connection: 'close' })
  res.end(JSON.stringify(errorBody('body-too-large', message)))
}

