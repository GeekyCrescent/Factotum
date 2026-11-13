/**
 * What the facade reads of the disk (design D5, D13 `start` step 3): the vault's master CV, guide and
 * base CVs (READ ONLY, at every run: a changed master CV is the next run's), the CV font from
 * `assets/`, whether the configured binaries exist, a version's files confined to `artifacts/`, and the
 * printer the rewrite is given (H5b's steps 5–7, `PrintFn`).
 *
 * NOTHING HERE THROWS, and a reason never carries a path of the owner's or a value of a file.
 */

import { accessSync, constants, existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { delimiter, extname, isAbsolute, join, sep } from 'node:path'

import { CLAUDE_BIN, uuidv7 } from '@factotum/sessions'

import type { CvSources } from '../build/cv.ts'
import { clearRender, keepPrint, printCv, type PrintDeps } from '../build/print.ts'
import type { HostConfig } from '../config.ts'
import type { PrintFn } from '../review/rewrite.ts'
import { parseCvs } from '../seed/kit.ts'
import { ARTIFACTS_DIR } from '../send/attachment.ts'
import type { Db } from '../store/db.ts'
import { latestProfileVersion } from '../store/repo.ts'
import { fail, ok, type Result } from '../types.ts'
import type { Health, PathState } from './types.ts'

const FONT_FILE = new URL('../../assets/Geist-Variable.latin.woff2', import.meta.url)

const codeOf = (error: unknown): string => {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : 'error'
}

export interface VaultReader {
  /** `cv-maestro.md`, whole. */
  readonly master: () => Result<string>
  /** The master CV and the guide (the verifier's and the rewrite's fixed part). */
  readonly fixed: () => Result<{ readonly master: string; readonly guide: string }>
  /** The builder's: the fixed part and the base CVs of `01-cvs.md` (none when it cannot be read). */
  readonly sources: () => Result<CvSources>
}

export function vaultReader(vault: HostConfig['vault']): VaultReader {
  const read = (what: string, relative: string): Result<string> => {
    try {
      return ok(readFileSync(join(vault.root, relative), 'utf8'))
    } catch (error) {
      return fail('module-error', `jobs: the ${what} cannot be read (${codeOf(error)})`)
    }
  }
  const master = (): Result<string> => read('master CV', vault.cvMaster)
  const fixed = (): Result<{ readonly master: string; readonly guide: string }> => {
    const cv = master()
    if (!cv.ok) return cv
    const guide = read('guide', vault.guide)
    return guide.ok ? ok({ master: cv.value, guide: guide.value }) : guide
  }
  const sources = (): Result<CvSources> => {
    const both = fixed()
    if (!both.ok) return both
    const cvs = read('base CVs', vault.seed.cvs)
    let bases: CvSources['bases'] = {}
    try {
      bases = cvs.ok ? parseCvs(cvs.value) : {}
    } catch {
      // A base that does not parse is a CV without a base, as a missing file is (D5).
    }
    return ok({ ...both.value, bases })
  }
  return { master, fixed, sources }
}

/** The CV font, read once at start; null when it cannot be (health says so, and no CV prints). */
export function readFont(read: () => Uint8Array = () => readFileSync(FONT_FILE)): Uint8Array | null {
  try {
    return read()
  } catch {
    return null
  }
}

const isExecutable = (path: string): boolean => {
  try {
    if (!statSync(path).isFile()) return false
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * The binary the generation spawns, found as `spawn` finds it (`ai/run.ts`): a name with a `/` as is,
 * a bare name on the daemon's `PATH` — a systemd unit's PATH is not the login shell's.
 */
export function findBinary(bin: string, envPath: string): string | null {
  if (bin.includes('/')) return isExecutable(bin) ? bin : null
  for (const dir of envPath.split(delimiter)) {
    if (dir === '') continue
    const candidate = join(dir, bin)
    if (isExecutable(candidate)) return candidate
  }
  return null
}

export interface BinaryLookup {
  /** `JobsDeps.claudeBin`; `CLAUDE_BIN` without it, as the queue. */
  readonly claudeBin: string | undefined
  /** The daemon's `PATH`. */
  readonly envPath: string
}

/** D13 step 3: what is there, without opening anything. */
export function checkPaths(config: HostConfig, font: Uint8Array | null, lookup: BinaryLookup): Health['paths'] {
  const at = (path: string): PathState => (existsSync(path) ? 'ok' : 'missing')
  const inVault = (relative: string): PathState => at(join(config.vault.root, relative))
  const { seed } = config.vault
  return {
    vault: at(config.vault.root),
    cvMaster: inVault(config.vault.cvMaster),
    guide: inVault(config.vault.guide),
    seedCompanies: inVault(seed.companies),
    seedKit: inVault(seed.kit),
    seedCvs: inVault(seed.cvs),
    seedPackages: seed.packages.every((entry) => inVault(entry.file) === 'ok') ? 'ok' : 'missing',
    chromium: at(config.chromium),
    pdfinfo: at(config.poppler.pdfinfo),
    pdftoppm: at(config.poppler.pdftoppm),
    font: font === null ? 'missing' : 'ok',
    claude: findBinary(lookup.claudeBin ?? CLAUDE_BIN, lookup.envPath) === null ? 'missing' : 'ok',
  }
}

type PathKey = keyof Health['paths']

const PATH_LINES: Readonly<Record<PathKey, string>> = {
  vault: 'Vault: the vault folder is missing',
  cvMaster: 'Vault: the master CV is missing',
  guide: 'Vault: the guide for the agent is missing; every CV generation fails until it is there',
  seedCompanies: 'Vault: the companies file of the seed is missing',
  seedKit: 'Vault: the kit file of the seed is missing',
  seedCvs: 'Vault: the base CVs file is missing',
  seedPackages: 'Vault: a seed package file is missing; the import cannot read it',
  chromium: 'Chromium: the configured binary is missing; no CV can print',
  pdfinfo: 'Poppler: pdfinfo is missing; no CV can print',
  pdftoppm: 'Poppler: pdftoppm is missing; no preview can be made',
  font: 'The CV font could not be read; no CV can print',
  claude: 'Claude: the claude binary is not on the daemon\'s PATH; every CV generation fails',
}

/** Under `vault.root`: with the folder itself missing, one line says it all. */
const IN_VAULT: ReadonlySet<PathKey> = new Set<PathKey>(['cvMaster', 'guide', 'seedCompanies', 'seedKit', 'seedCvs', 'seedPackages'])

export const pathWarnings = (paths: Health['paths']): readonly string[] =>
  (Object.keys(paths) as PathKey[])
    .filter((key) => paths[key] === 'missing' && !(paths.vault === 'missing' && IN_VAULT.has(key)))
    .map((key) => PATH_LINES[key])

/** What every CV generation needs, as `pathWarnings` says it: the import adds these to its report. */
export const generationWarnings = (paths: Health['paths']): readonly string[] =>
  pathWarnings({ ...paths, seedCompanies: 'ok', seedKit: 'ok', seedCvs: 'ok', seedPackages: 'ok' })

const realpathOf = (path: string): string | null => {
  try {
    return realpathSync(path)
  } catch {
    return null
  }
}

/**
 * The real path of a stored artifact when it is a regular file with this extension under the real
 * `<stateDir>/artifacts/` (as `attachment.ts` confines the PDF it sends); otherwise null.
 */
export function confinedArtifact(stateDir: string, path: string, extension: '.pdf' | '.png'): string | null {
  const root = realpathOf(join(stateDir, ARTIFACTS_DIR))
  const real = realpathOf(isAbsolute(path) ? path : join(stateDir, path))
  if (root === null || real === null || !real.startsWith(root + sep)) return null
  if (extname(real).toLowerCase() !== extension) return null
  try {
    return statSync(real).isFile() ? real : null
  } catch {
    return null
  }
}

/** The rewrite's printer (`RewriteDeps.print`): H5b's steps 5–7 with today's profile, its render folder cleared. */
export function printer(db: Db, deps: PrintDeps): PrintFn {
  return async ({ applicationId, version, cv, signal }) => {
    const profile = db.read((q) => latestProfileVersion(q))
    if (profile === undefined) return fail('module-error', 'there is no profile to print with')
    const renderId = uuidv7()
    try {
      const printed = await printCv(deps, renderId, cv, profile.profile, signal)
      if (!printed.ok) return fail('module-error', printed.reason)
      const kept = await keepPrint(deps, applicationId, version, printed.value, signal)
      if (!kept.ok) return fail('module-error', kept.reason)
      return ok({ pdf: kept.value.pdf, png: kept.value.png, contactHash: printed.value.contactHash, pages: printed.value.pages })
    } finally {
      clearRender(deps, renderId)
    }
  }
}
