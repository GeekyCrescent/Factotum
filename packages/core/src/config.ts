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
     * Extra allowed origins, for anyone putting a proxy in front that is not
     * `tailscale serve`. The two origins factotum accepts by default are exact and
     * declared — `publicOrigin` below, and the bind itself when it is loopback — so
     * this is an operator's hatch and not the mechanism. See `net/origin.ts`.
     *
     * The one place it is the right answer is `pnpm dev`: Vite serves the client on
     * `http://localhost:5173` and proxies the API, so the browser sends that origin
     * on every POST. It is worth knowing what it costs — `localhost:5173` is
     * literally "another service on this machine", the thing the policy exists to
     * refuse — so it belongs in a dev config and never in `config.template.json`.
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

/**
 * THE CANONICAL-ORIGIN RULE, in one place: `publicOrigin` and every peer use it.
 *
 * The origin the client is actually served on.
 *
 * Declared, never derived: with `tailscale serve` terminating TLS in front, the
 * daemon has no way to know the name the certificate covers, and guessing it is the
 * kind of thing that works on the author's machine.
 *
 * IT MUST BE CANONICAL, AND THE GUARD IS DOUBLE ON PURPOSE.
 *
 * The origin policy compares raw strings, so anything not canonical here means 403 on
 * every request with `doctor` printing two values that look identical. `v === u.origin`
 * catches a trailing slash, upper case, credentials and an explicit `:443`.
 *
 * It does NOT catch a trailing dot, and that is the one that would actually have
 * happened: `new URL('https://x.ts.net.').origin` is byte-identical to its input, and
 * `tailscale status --json` returns `Self.DNSName` WITH the trailing dot — measured on
 * a real tailnet, it comes back `'juans-macbook-pro.tailbd0167.ts.net.'`. That is the
 * exact string `init` composes from, while the browser sends the name without the dot.
 * So the second half of this guard is not defensive programming; it is the failure the
 * fourth revision of this design shipped.
 */
export function isCanonicalOrigin(v: string): boolean {
  try {
    const u = new URL(v)
    if (v !== u.origin) return false
    return !u.hostname.endsWith('.')
  } catch {
    return false
  }
}

/**
 * https:, or http: to a LOOPBACK host only (security review, 2026-10-08): the proxy and the relay send
 * everything the owner does on the other host to this origin, and plain http: across the network
 * would carry it in clear. A URL's hostname, already normalised by `new URL` — not a bind address, so
 * not `isLoopback` of `net/ranges.ts`, which the core cannot import and which answers another question.
 */
function isSecureOrLoopback(v: string): boolean {
  try {
    const { protocol, hostname } = new URL(v)
    if (protocol === 'https:') return true
    return protocol === 'http:' && (hostname === 'localhost' || hostname === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(hostname))
  } catch {
    return false
  }
}

const publicOriginSchema = z.string().refine(isCanonicalOrigin, {
  message: 'publicOrigin must be a bare canonical origin with no trailing dot, e.g. https://host.tailnet.ts.net',
})

/**
 * The other daemon this one shows as a host of the same app (spec 2026-10-07, D1).
 *
 * THE SAME RULE AS `publicOrigin`, reused rather than copied: a peer's origin is the other
 * daemon's `publicOrigin`, and the proxy compares the URL it builds against it by exact
 * equality — so a trailing dot here would refuse every call with nothing visibly wrong. Its own
 * message, so a mistyped peer does not report itself as `publicOrigin`. It demands https: except
 * on loopback, where the tests pair two daemons over http.
 *
 * AT MOST ONE. More than two hosts is out of scope, and the client is built for one peer.
 */
export const peerSchema = z.object({
  origin: z
    .string()
    .refine(isCanonicalOrigin, {
      message: 'a peer origin must be a bare canonical origin with no trailing dot, e.g. https://other.tailnet.ts.net',
    })
    .refine(isSecureOrLoopback, {
      message: 'a peer origin must be https: unless its host is loopback (127.0.0.0/8, ::1, localhost)',
    }),
})

export const rootConfigSchema = z.object({
  /**
   * Cross-checked against the resolved environment. Without this, copying
   * `prod/config.json` into `dev/` to "test quickly" starts a dev that believes it is
   * prod, on prod's port — and the failure surfaces as an EADDRINUSE that explains
   * nothing.
   */
  environment: environmentSchema,
  listen: listenSchema,
  publicOrigin: publicOriginSchema,
  peers: z.array(peerSchema).max(1, 'at most one peer: more than two hosts is not supported').default([]),
  modules: z.record(z.string(), moduleEntrySchema).default({}),
})

export type RootConfig = z.infer<typeof rootConfigSchema>
export type PeerConfig = z.infer<typeof peerSchema>
