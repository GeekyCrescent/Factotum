/**
 * Reading the seed out of the vault (design D8): the files named by `vault.seed`, relative to
 * `vault.root`, through the pure parsers. READ ONLY — nothing here writes, to the vault or anywhere.
 *
 * NOTHING HERE THROWS: a file that does not read, or a companies file of the wrong shape, is a
 * `module-error` that names the configured path (never a value of the file).
 */

import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { fail, ok, type Result } from '../types.ts'
import { parseCompanies, parseHealthEmployers, type SeededCompany } from './companies.ts'
import { parseCvs, parseKit, seedFollowupTemplates, type BaseCvs, type Kit } from './kit.ts'
import type { UnparsedHeading } from './markdown.ts'
import { parsePackage, type PackageFile } from './package.ts'

/** One entry of `vault.seed.packages` (design D13). */
export interface SeedPackage {
  readonly file: string
  readonly holdUntil?: string | undefined
  readonly byHand?: boolean | undefined
}

/** What the import needs of `vault`: the root and the seed paths. */
export interface SeedVault {
  readonly root: string
  readonly seed: {
    readonly companies: string
    readonly kit: string
    readonly cvs: string
    readonly packages: readonly SeedPackage[]
  }
}

export interface SeedSource {
  readonly vault: SeedVault
  /** The seam for the files; `readFile` by default. */
  readonly readText?: ((path: string) => Promise<string>) | undefined
  /** The curated list (`assets/health-employers.json`) by default. */
  readonly healthEmployers?: readonly string[] | undefined
}

export interface ReadPackage {
  readonly config: SeedPackage
  /** The file's base name: what `seed_key` and the report use. */
  readonly name: string
  readonly parsed: PackageFile
}

export interface Seed {
  /** The companies file's base name, for the report. */
  readonly companiesFile: string
  readonly companies: readonly SeededCompany[]
  readonly kit: Kit
  readonly cvs: BaseCvs
  readonly templateWarnings: readonly string[]
  readonly packages: readonly ReadPackage[]
  /** Every `## ` heading of the kit and the packages that is not `## N. Title`, with its file. */
  readonly unparsed: readonly (UnparsedHeading & { readonly file: string })[]
}

const HEALTH_FILE = new URL('../../assets/health-employers.json', import.meta.url)

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))
const defaultRead = (path: string): Promise<string> => readFile(path, 'utf8')

async function readText(source: SeedSource, relative: string): Promise<Result<string>> {
  try {
    return ok(await (source.readText ?? defaultRead)(join(source.vault.root, relative)))
  } catch {
    return fail('module-error', `seed: cannot read ${relative}`)
  }
}

async function healthEmployers(source: SeedSource): Promise<Result<readonly string[]>> {
  if (source.healthEmployers !== undefined) return ok(source.healthEmployers)
  try {
    return ok(parseHealthEmployers(JSON.parse(await readFile(HEALTH_FILE, 'utf8'))))
  } catch (error) {
    return fail('module-error', `seed: ${messageOf(error)}`)
  }
}

/** A parser that throws becomes a `module-error` naming the file. */
function parsed<T>(relative: string, parse: () => T): Result<T> {
  try {
    return ok(parse())
  } catch (error) {
    return fail('module-error', `seed: ${relative}: ${messageOf(error)}`)
  }
}

/** `JSON.parse` quotes the text in its message: the reason keeps only that it is not JSON. */
function jsonOf(name: string, text: string): Result<unknown> {
  try {
    return ok(JSON.parse(text))
  } catch {
    return fail('module-error', `seed: ${name}: not JSON`)
  }
}

async function readPackages(source: SeedSource, kit: Kit): Promise<Result<readonly ReadPackage[]>> {
  const packages: ReadPackage[] = []
  for (const config of source.vault.seed.packages) {
    const markdown = await readText(source, config.file)
    if (!markdown.ok) return markdown
    const name = basename(config.file)
    packages.push({ config, name, parsed: parsePackage(name, markdown.value, kit) })
  }
  return ok(packages)
}

/** Every file of the seed, read and parsed; the first that fails is the answer. */
export async function readSeed(source: SeedSource): Promise<Result<Seed>> {
  const { seed } = source.vault
  const [companiesText, kitText, cvsText, health] = await Promise.all([
    readText(source, seed.companies),
    readText(source, seed.kit),
    readText(source, seed.cvs),
    healthEmployers(source),
  ])
  if (!companiesText.ok) return companiesText
  if (!kitText.ok) return kitText
  if (!cvsText.ok) return cvsText
  if (!health.ok) return health
  const companiesJson = jsonOf(basename(seed.companies), companiesText.value)
  if (!companiesJson.ok) return companiesJson
  const companies = parsed(basename(seed.companies), () => parseCompanies(companiesJson.value, health.value))
  if (!companies.ok) return companies
  const cvs = parsed(basename(seed.cvs), () => parseCvs(cvsText.value))
  if (!cvs.ok) return cvs
  const kit = parseKit(kitText.value)
  const packages = await readPackages(source, kit)
  if (!packages.ok) return packages
  const { warnings } = seedFollowupTemplates(kitText.value)
  const unparsed = [
    ...kit.unparsed.map((u) => ({ file: basename(seed.kit), ...u })),
    ...packages.value.flatMap(({ name, parsed }) => parsed.unparsed.map((u) => ({ file: name, ...u }))),
  ]
  return ok({ companiesFile: basename(seed.companies), companies: companies.value, kit, cvs: cvs.value, templateWarnings: warnings, packages: packages.value, unparsed })
}
