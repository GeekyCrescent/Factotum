/**
 * Test-only pieces of the replies' tests (tasks Q1–Q3). Excluded from coverage (`src/test-*.ts`).
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export { hasOpenssl } from './test-send.ts'

let tls: { ca: string; key: string; cert: string } | undefined

/** A throwaway CA and a certificate for localhost/127.0.0.1, once per process. No private key is versioned. */
export function replyCertificates(): { ca: string; key: string; cert: string } {
  if (tls !== undefined) return tls
  const dir = mkdtempSync(join(tmpdir(), 'jobs-replies-tls-'))
  const run = (args: readonly string[]): void => void execFileSync('openssl', args, { cwd: dir, stdio: 'ignore' })
  run(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.crt', '-days', '1', '-subj', '/CN=jobs-replies-ca',
    '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign'])
  run(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'srv.key', '-out', 'srv.csr', '-subj', '/CN=localhost'])
  writeFileSync(join(dir, 'ext'), 'subjectAltName=DNS:localhost,IP:127.0.0.1\n')
  run(['x509', '-req', '-in', 'srv.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'srv.crt', '-days', '1', '-extfile', 'ext'])
  const read = (name: string): string => readFileSync(join(dir, name), 'utf8')
  tls = { ca: read('ca.crt'), key: read('srv.key'), cert: read('srv.crt') }
  return tls
}

/** An IMAP `INTERNALDATE`, in UTC. */
export function imapDate(date: Date): string {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(date.getUTCDate())}-${months[date.getUTCMonth()]}-${date.getUTCFullYear()} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} +0000`
}
