/**
 * Helpers for this package's own tests (spec 2026-11-12, M6; M3b will reuse them). Test-only:
 * excluded from coverage, and NOT re-exported from `./testing` — the consumers have their own.
 */

import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Timers } from '@factotum/core'

export interface ManualTimers {
  readonly timers: Timers
  /** Fires every timeout of exactly `ms`, or all of them; returns how many fired. */
  readonly fire: (ms?: number) => number
  readonly pending: () => readonly number[]
}

export function manualTimers(): ManualTimers {
  const waiting = new Map<symbol, { readonly fn: () => void; readonly ms: number }>()
  const timers: Timers = {
    setTimeout: (fn, ms) => {
      const key = Symbol('timeout')
      waiting.set(key, { fn, ms })
      return { [Symbol.dispose]: () => void waiting.delete(key) }
    },
    setInterval: () => ({ [Symbol.dispose]: () => undefined }),
  }
  return {
    timers,
    fire: (ms) => {
      const due = [...waiting.entries()].filter(([, timer]) => ms === undefined || timer.ms === ms)
      for (const [key, timer] of due) {
        waiting.delete(key)
        timer.fn()
      }
      return due.length
    },
    pending: () => [...waiting.values()].map((timer) => timer.ms),
  }
}

/** Polls instead of guessing a delay (CLAUDE.md §7). */
export async function eventually(check: () => boolean, ms = 5_000): Promise<void> {
  const until = Date.now() + ms
  while (!check()) {
    if (Date.now() > until) throw new Error('eventually: the condition never held')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

export function hasOpenssl(): boolean {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/**
 * A throwaway CA and a server certificate for `localhost`/127.0.0.1, made by openssl for this run.
 * No private key is versioned; TLS is verified against `ca`, never switched off (guardrail 6).
 */
export async function certificates(): Promise<{ ca: string; key: string; cert: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'factotum-mail-tls-'))
  const run = (args: readonly string[]): void => void execFileSync('openssl', args, { cwd: dir, stdio: 'ignore' })
  run(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.crt', '-days', '1',
    '-subj', '/CN=factotum-test-ca', '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign'])
  run(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'srv.key', '-out', 'srv.csr', '-subj', '/CN=localhost'])
  await writeFile(join(dir, 'ext'), 'subjectAltName=DNS:localhost,IP:127.0.0.1\n')
  run(['x509', '-req', '-in', 'srv.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'srv.crt', '-days', '1', '-extfile', 'ext'])
  const read = (name: string): Promise<string> => readFile(join(dir, name), 'utf8')
  return { ca: await read('ca.crt'), key: await read('srv.key'), cert: await read('srv.crt') }
}
