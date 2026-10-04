/**
 * What the CLI says it can invoke, kept between sessions (spec 2026-10-03-skills-a-mano, D2).
 *
 * THE LIST ONLY EXISTS INSIDE A SESSION (§0.3): it is the `init` line of the stream, and nothing the
 * daemon can ask for on its own returns it. So the engine takes it from any session's `init`, keeps it
 * in memory, and writes it to one file so a restart still has it (criterion 2).
 *
 * Two halves. `announcedOf` is pure — what a line means. `createAnnounced` is the file and the
 * bookkeeping around it: when to write, and how a broken file or a bad name is reported.
 */

import { readFile, rename, writeFile } from 'node:fs/promises'
import type { Logger } from '@factotum/core'
import { isInvokableName } from './catalog.ts'
import type { Announced } from './types.ts'

/** More than this in one list is not a list of skills; the rest is cut and counted (criterion 4). */
export const MAX_ANNOUNCED = 1_000

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** The CLI's own internals (`__remote-workflow`): not for the owner and not bad data, so skipped silently. */
const isInternal = (name: unknown): boolean => typeof name === 'string' && name.startsWith('__')

/** Valid names, once each, in order, at most `MAX_ANNOUNCED`. What is not kept is counted, internals aside. */
function cleaned(all: readonly unknown[]): { readonly names: readonly string[]; readonly dropped: number } {
  const raw = all.filter((name) => !isInternal(name))
  const valid = raw.filter((name): name is string => typeof name === 'string' && isInvokableName(name))
  const unique = [...new Set(valid)]
  const names = unique.slice(0, MAX_ANNOUNCED)
  return { names, dropped: raw.length - valid.length + (unique.length - names.length) }
}

const stringsOf = (value: unknown): readonly string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []

/**
 * `undefined` when `skills` OR `agents` is not an array, so a good list is never overwritten by an empty
 * one. Any session's `init` counts, also one launched as an agent: it announces the same list (§0.11).
 */
export function announcedOf(
  line: unknown,
  at: string,
): { readonly announced: Announced; readonly dropped: number } | undefined {
  if (!isRecord(line) || !Array.isArray(line.skills) || !Array.isArray(line.agents)) return undefined

  const skills = cleaned(line.skills)
  const agents = cleaned(line.agents)

  // The subtraction is on the raw names, BEFORE they are judged: a bad name that is both a skill and a
  // slash command is one bad name, not two.
  const known = new Set<unknown>([...line.skills, ...stringsOf(line.terminal_slash_commands)])
  const slash = Array.isArray(line.slash_commands) ? line.slash_commands : []
  const commands = cleaned(slash.filter((name) => !known.has(name)))

  return {
    announced: {
      skills: skills.names,
      agents: agents.names,
      commands: commands.names,
      version: typeof line.claude_code_version === 'string' ? line.claude_code_version : undefined,
      since: at,
    },
    dropped: skills.dropped + agents.dropped + commands.dropped,
  }
}

const sameNames = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((name, index) => name === b[index])

/** Criterion 1: `since` moves only when what is announced does. */
const sameList = (a: Announced, b: Announced): boolean =>
  sameNames(a.skills, b.skills) && sameNames(a.agents, b.agents) && sameNames(a.commands, b.commands) && a.version === b.version

/** What `JSON.stringify` leaves of an `Announced` — `version` is absent when `undefined`. */
function fromFile(value: unknown): Announced | undefined {
  if (!isRecord(value)) return undefined
  const { skills, agents, commands, version, since } = value
  const isNames = (names: unknown): names is string[] => Array.isArray(names) && names.every((name) => typeof name === 'string')
  if (!isNames(skills) || !isNames(agents) || !isNames(commands) || typeof since !== 'string') return undefined
  if (version !== undefined && typeof version !== 'string') return undefined
  return { skills, agents, commands, version, since }
}

/** Same pattern as `writeAtomically` in the module's registry: a reader never sees half a file. */
async function writeAtomically(file: string, text: string): Promise<void> {
  const temp = `${file}.tmp`
  await writeFile(temp, text, 'utf8')
  await rename(temp, file)
}

export interface AnnouncedStore {
  /** Read once at engine start. A broken file is `undefined` and one warning, never a throw. */
  readonly load: () => Promise<void>
  readonly get: () => Announced | undefined
  /** From `onInit`. Writes only when the three lists or the version changed (criterion 1). */
  readonly take: (line: unknown) => void
}

export function createAnnounced(deps: {
  readonly file: string
  readonly log: Logger
  readonly now: () => Date
  /** Only for tests that count writes. */
  readonly write?: (file: string, text: string) => Promise<void>
}): AnnouncedStore {
  const write = deps.write ?? writeAtomically
  let current: Announced | undefined
  let hasWarnedOfDrops = false
  // One promise, like the log's writes: `take` is called from a turn and never makes it wait.
  let chain: Promise<unknown> = Promise.resolve()

  const load = async (): Promise<void> => {
    let text: string
    try {
      text = await readFile(deps.file, 'utf8')
    } catch (error) {
      // No file is the normal first start. Anything else is worth saying.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') deps.log.warn(`the announced list could not be read: ${(error as Error).message}`)
      return
    }
    try {
      current = fromFile(JSON.parse(text))
    } catch {
      current = undefined
    }
    if (current === undefined) deps.log.warn(`the announced list in ${deps.file} is not in the shape expected; the next session will write it again`)
  }

  const take = (line: unknown): void => {
    const result = announcedOf(line, deps.now().toISOString())
    if (result === undefined) return

    // Once per daemon, not per session: every session would say the same thing about the same list.
    if (result.dropped > 0 && !hasWarnedOfDrops) {
      hasWarnedOfDrops = true
      deps.log.warn(`the CLI announced ${result.dropped} name(s) that cannot be invoked or are past ${MAX_ANNOUNCED}; they were left out`)
    }

    if (current !== undefined && sameList(current, result.announced)) return
    const next = result.announced
    current = next
    chain = chain
      .then(async () => await write(deps.file, `${JSON.stringify(next, null, 2)}\n`))
      .catch((error: unknown) => deps.log.warn(`the announced list could not be saved: ${error instanceof Error ? error.message : 'error'}`))
  }

  return { load, get: () => current, take }
}
