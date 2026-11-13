/**
 * Test-only pieces of the facade's tests (tasks C1): a vault in temp (the seed fixtures, a synthetic
 * master CV and guide), a config pointing at it and at the fake binaries, the network refused, and
 * `createJobs` with every seam a test needs. ALL SYNTHETIC.
 */

import assert from 'node:assert/strict'
import { chmodSync, copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { DOC, MASTER } from './build/test-cv.ts'
import { FAKE_CHROMIUM, FAKE_CLAUDE, FAKE_PDFINFO, FAKE_PDFTOPPM, GUIDE } from './build/test-builder.ts'
import type { Jobs, JobsDeps } from './facade/types.ts'
import { createJobs } from './jobs.ts'
import { ADS, FIXTURES, HOLD, NOW, WAVE1, WAVE2 } from './seed/test-seed.ts'
import { capturedLog, realTimers, type CapturedLog } from './test-support.ts'

export { NOW }

export interface Rig {
  readonly vault: string
  readonly stateDir: string
  readonly passwordFile: string
  readonly config: Record<string, unknown>
}

/** A vault, a state folder and a password file under `dir`; fake-claude answers every CV with `DOC`. */
export function rigIn(dir: string, passwordMode = 0o600): Rig {
  const vault = join(dir, 'vault')
  const stateDir = join(dir, 'state')
  mkdirSync(vault, { recursive: true })
  mkdirSync(join(stateDir, 'run'), { recursive: true })
  for (const name of ['companies.json', 'kit.md', 'cvs.md', ADS, WAVE1, WAVE2]) copyFileSync(join(FIXTURES, name), join(vault, name))
  writeFileSync(join(vault, 'cv-maestro.md'), MASTER)
  writeFileSync(join(vault, 'guide.md'), GUIDE)
  // One answer for every call: the CV run reads a `CvDoc`, the verifier `{ unsupported }` (both schemas drop what is not theirs).
  writeFileSync(join(stateDir, 'run', 'fake-claude.answer'), JSON.stringify({ ...DOC, unsupported: [] }))
  const passwordFile = join(dir, 'gmail-jobs')
  writeFileSync(passwordFile, 'abcd efgh ijkl mnop')
  chmodSync(passwordFile, passwordMode)
  const config = {
    timeZone: 'Australia/Sydney',
    vault: {
      root: vault,
      cvMaster: 'cv-maestro.md',
      guide: 'guide.md',
      seed: { companies: 'companies.json', kit: 'kit.md', cvs: 'cvs.md', packages: [{ file: ADS }, { file: WAVE1 }, { file: WAVE2, holdUntil: HOLD }] },
    },
    mail: { address: 'alex@example.test', displayName: 'Alex Example', passwordFile },
    chromium: FAKE_CHROMIUM,
    poppler: { pdfinfo: FAKE_PDFINFO, pdftoppm: FAKE_PDFTOPPM },
    claude: { concurrency: 3 },
  }
  return { vault, stateDir, passwordFile, config }
}

export function depsOf(rig: Rig, over: Partial<JobsDeps> = {}): JobsDeps & { readonly captured: CapturedLog } {
  const captured = capturedLog()
  return {
    captured,
    config: rig.config,
    stateDir: rig.stateDir,
    log: captured.log,
    now: () => NOW,
    timers: realTimers,
    claudeBin: FAKE_CLAUDE,
    sendMail: async () => ({ ok: false, phase: 'before-data', reason: 'no SMTP in tests' }),
    fetch: async () => {
      throw new Error('offline')
    },
    lookup: async () => ['93.184.216.34'],
    ...over,
  }
}

export async function started(deps: JobsDeps): Promise<Jobs> {
  const created = await createJobs(deps)
  if (!created.ok) assert.fail(created.reason)
  if (!('jobs' in created)) assert.fail('expected a host')
  return created.jobs
}
