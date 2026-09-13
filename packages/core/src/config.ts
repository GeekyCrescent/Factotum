/**
 * Every shape that is validated at a boundary. Nothing here does I/O.
 *
 * The real config lives at `~/.factotum/<env>/config.json` and is never versioned.
 * The repository ships a template and nothing else.
 */

import { z } from 'zod'
import { ENVIRONMENTS } from './env.ts'

export const environmentSchema = z.enum(ENVIRONMENTS)

/**
 * A module id names its config block, its route prefix, its state directory and its
 * client path. An id containing `/` or `..` — an accident, not an attack — escapes
 * the state root and breaks mounting, so the shape is checked when the registry is
 * composed and a bad one aborts startup: that is a programming error, not a
 * configuration error.
 */
export const moduleIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]*$/, 'module id must match /^[a-z][a-z0-9-]*$/')

/**
 * Where to listen.
 *
 * EXACTLY ONE of `address` or `interface`. Startup never guesses: auto-detection
 * lives in `factotum init`, which writes the value it found. A config that declares
 * nothing does not validate.
 *
 * `init` writes `address`, not `interface`, and that ordering matters: on macOS the
 * Tailscale interface is named `utunN` and the number CHANGES ACROSS REBOOTS, while
 * the 100.x address is stable per node. `interface` stays available for Linux, where
 * `tailscale0` is stable.
 */
export const listenSchema = z
  .object({
    address: z.string().min(1).optional(),
    interface: z.string().min(1).optional(),
    port: z.number().int().min(1024).max(65535),
    /**
     * Extra allowed origins, for anyone putting a reverse proxy in front. Everything
     * else about the origin policy is decided by shape — see `net/origin.ts`.
     */
    extraOrigins: z.array(z.string()).default([]),
  })
  .refine(
    (v) => (v.address ? 1 : 0) + (v.interface ? 1 : 0) === 1,
    { message: 'declare exactly one of `address` or `interface`' },
  )

export type ListenConfig = z.infer<typeof listenSchema>

/**
 * One module's block.
 *
 * `.catchall(z.unknown())` IS LOAD-BEARING AND MUST NOT BE REMOVED.
 *
 * Zod strips unknown keys. The root schema does not know any module's fields, so
 * without the catchall, validating the root config would EMPTY every module's
 * fragment before its owner ever saw it. The same trap, in the predecessor project,
 * silently deleted fields from disk whenever a parsed object was written back.
 *
 * And it repeats one level down: a module's own `configSchema` also drops unknown
 * keys. That is harmless while a module only reads its fragment, and stops being
 * harmless the moment one re-reads and writes it back. `docs/writing-a-module.md`
 * carries that warning by name.
 */
export const moduleEntrySchema = z
  .object({
    /**
     * Off unless asked for. A module that needs configuration in order to start is
     * badly designed, and its default is "off".
     */
    enabled: z.boolean().default(false),
  })
  .catchall(z.unknown())

export type ModuleEntry = z.infer<typeof moduleEntrySchema>

export const rootConfigSchema = z.object({
  /**
   * Cross-checked against the resolved environment. Without this, copying
   * `prod/config.json` into `dev/` to "test quickly" starts a dev that believes it is
   * prod, on prod's port — and the failure surfaces as an EADDRINUSE that explains
   * nothing.
   */
  environment: environmentSchema,
  listen: listenSchema,
  modules: z.record(z.string(), moduleEntrySchema).default({}),
})

export type RootConfig = z.infer<typeof rootConfigSchema>
