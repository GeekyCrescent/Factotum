/**
 * The module contract. This file is the whole point of the project: everything the
 * kernel knows how to do is generic, and everything specific arrives through here.
 *
 * Five fields, and no more. A sixth needs a consumer that exists TODAY — see the
 * spec's risk 6. Files fit without one: an upload is a kind of ROUTE, and a file is a kind of
 * RESPONSE (`http.ts`, ADR-0012) — the contract and the context did not grow.
 *
 * Notifications and files were the two things once recorded as not fitting. Notifications got a
 * consumer — the permission gate asking the owner — and arrived as a field of `ModuleContext`, not
 * of this interface: `notify` below (ADR-0008). Files got one too, and needed no field at all.
 */

import type { Logger } from './log.ts'
import type { NavEntry } from './nav.ts'
import type { RouteTable } from './http.ts'
import type { Environment } from './env.ts'

/**
 * `id` names four things, so it is the most load-bearing string in the system:
 * its config block (`modules.<id>`), its route prefix (`/modules/<id>/`), its state
 * directory (`~/.factotum/<env>/modules/<id>/`) and its client path (`/m/<id>`).
 *
 * It is validated against `moduleIdSchema` when the registry is composed. Changing
 * it later means migrating config and state.
 */
export interface FactotumModule<C = unknown> {
  readonly id: string

  /** Without a schema, the module gets no configuration of its own. */
  readonly configSchema?: import('zod').ZodType<C>

  /**
   * HTTP routes. They are RETURNED, never mounted: a module is handed nothing it
   * could listen with, which is what keeps the network surface decided in one place.
   */
  readonly routes?: (ctx: ModuleContext<C>) => RouteTable

  /** Without this, the module has no screen. */
  readonly nav?: NavEntry

  /**
   * Background work. Called at step 12 of boot — AFTER the bind has been verified,
   * so nothing touches the network or the disk until we know where we are listening.
   *
   * Bounded by MODULE_START_TIMEOUT_MS: a `start` that hangs gets the module
   * disabled rather than leaving the whole daemon stuck at "starting".
   */
  readonly start?: (ctx: ModuleContext<C>) => Promise<ModuleHandle> | ModuleHandle
}

/** What a module returns so the kernel can shut it down. */
export interface ModuleHandle {
  readonly stop: () => Promise<void> | void
}

/**
 * What a module receives.
 *
 * The absences are the design. A module is NOT given:
 *
 * - the server, the port or the address — it could otherwise decide the network
 *   surface on its own, and the entire security model depends on that living in
 *   exactly one place;
 * - the root config — it has no business knowing which port the kernel runs on;
 * - another module's config, or the registry — two modules that talk through
 *   configuration are one module split badly. This is the absence most likely to
 *   hurt: two of the owner's Jarvis modules already consume each other, and that is
 *   recorded as open question 2 rather than solved here;
 * - any path outside `stateDir`.
 *
 * None of this is a sandbox. A module runs in-process with full Node privileges and
 * can `import fs` or `import net` whenever it likes. The contract buys design
 * discipline, not containment of hostile code.
 */
export interface ModuleContext<C = unknown> {
  /** Already parsed by this module's own schema. Never `unknown`. */
  readonly config: C

  /** `~/.factotum/<env>/modules/<id>/`, created by the kernel before this exists. */
  readonly stateDir: string

  readonly env: Environment

  /** Prefixed with `[<id>]`. */
  readonly log: Logger

  readonly now: () => Date

  /**
   * Timers, injected.
   *
   * `now` alone is not enough: it cannot advance a `setInterval`, so a test of a
   * background task would have to actually wait. Both of the real modules this
   * contract was checked against inject their sleep clock for the same reason.
   *
   * THE KERNEL OWNS WHAT IT HANDS OUT HERE. It tracks every timer per module and
   * disposes them when the module stops or is disabled — otherwise a `start` that
   * creates an interval and then throws leaves the interval running with no
   * `ModuleHandle` to call, and the process never exits on SIGINT.
   *
   * The kernel also calls `unref()` on every timer it creates, so a module's
   * background work never by itself keeps the process alive. The predecessor project
   * does this by hand at each call site; here it is a property of the contract,
   * because `Disposable` hides the underlying handle and a module could not do it.
   */
  readonly timers: Timers

  /**
   * Reaching the owner's devices. THE SEVENTH FIELD, and it has exactly one consumer today:
   * the permission gate asking before it denies (ADR-0008).
   *
   * Named for what it does, not for how: a module does not know the transport is Web Push, so
   * the day there is another one, the kernel changes and no module does.
   *
   * The module's id and the machine's name are stamped by the kernel. A module cannot forge a
   * notice that looks like another module's, or like the daemon's own.
   */
  readonly notify: Notifier

  /**
   * Talking to THIS MODULE'S TWIN on the other host (spec 2026-10-07, D4). THE EIGHTH FIELD, and its
   * one consumer is the session handoff, which moves conversations between two daemons (ADR-0020).
   *
   * Narrow on purpose, like `notify` (ADR-0008): a module names a peer and a path RELATIVE TO ITSELF,
   * and the kernel builds the URL — `/modules/<this module's id>/<path>`, through the same rules as
   * the proxy — decides the timeout under a ceiling, and logs only the shape of the route. A module
   * is never given a URL, a socket or another module's routes.
   */
  readonly peers: PeerCaller
}

/** A peer as a module sees it: its name, and whether the last probe found it. */
export interface PeerView {
  readonly name: string
  readonly reachable: boolean
}

export interface PeerCallOptions {
  /** How long the WHOLE call may take. 10 s by default, at most `PEER_CALL_MAX_MS` (the kernel's). */
  readonly timeoutMs?: number
}

/**
 * What came back. NEVER A THROW: every way a call can go wrong is a `reason`.
 *
 * - `unreachable`: the peer is not declared, the probe has it down, or the connection failed;
 * - `refused`: the kernel would not send that path (a `..`, an escape), or the file to upload could not
 *   be opened — nothing left this host;
 * - `timeout`: no answer in time, which DOES NOT SAY whether the peer did the work;
 * - `bad-json`: a 2xx whose body is not JSON, or is over `MAX_BODY_BYTES`;
 * - `http`: the peer answered with a status that is not 2xx. `body` is its JSON, when it is JSON and
 *   fits — the module reads its own refusals from it; the kernel never interprets it.
 */
export type PeerResponse<T> =
  | { readonly ok: true; readonly status: number; readonly body: T }
  | {
      readonly ok: false
      readonly status: number | undefined
      readonly reason: 'unreachable' | 'refused' | 'timeout' | 'bad-json' | 'http'
      readonly body: unknown
    }

export interface PeerCaller {
  /** Synchronous, from the probe's last reading. */
  readonly list: () => readonly PeerView[]
  readonly json: <T = unknown>(
    peer: string,
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    options?: PeerCallOptions,
  ) => Promise<PeerResponse<T>>
  /**
   * A FILE, by its path, streamed to an upload route of the twin (ADR-0012: a module hands over a
   * path, never a stream). The kernel opens it and closes it whatever happens.
   */
  readonly upload: <T = unknown>(peer: string, path: string, file: string, options?: PeerCallOptions) => Promise<PeerResponse<T>>
}

/**
 * Two members, and the first exists so the second is never called in vain.
 *
 * `canReach` is SYNCHRONOUS on purpose. The permission gate asks it before deciding whether it
 * may ask at all, and that decision is pure: a promise here would push I/O into the one path in
 * the project that must not do any. Without it, the only way to know nobody is subscribed would
 * be to send and wait for the failure — freezing a session for a whole timeout in exactly the
 * case where nobody will answer.
 */
export interface Notifier {
  readonly canReach: () => boolean
  /** Never rejects. A notice that cannot be delivered is logged, not thrown at the caller. */
  readonly send: (message: NotificationMessage) => Promise<void>
}

export interface Timers {
  setInterval: (fn: () => void, ms: number) => Disposable
  setTimeout: (fn: () => void, ms: number) => Disposable
}

/**
 * What a MODULE builds to notify the owner. It does not know which machine it runs on, nor
 * its own id: the kernel adds both (see `PushEnvelope`), so a module cannot forge either.
 *
 * Everything here leaves the private network — it travels through the browser's push
 * service. Carry the least that is enough to decide, never a full path (spec §5).
 */
export interface NotificationMessage {
  readonly title: string
  readonly body: string
  /** Where a tap lands. Relative; the client resolves it against its own origin. */
  readonly path: string
  /** Collapses earlier notifications with the same tag. One per session is the intended use. */
  readonly tag: string
  /** Buttons, where the platform supports them. Absent means tap-to-open only. */
  readonly actions?: readonly { readonly action: string; readonly label: string }[]
  /** Opaque to the kernel. Handed to the service worker so an action knows what it answers. */
  readonly data?: Readonly<Record<string, unknown>>
  /**
   * This notice ASKS FOR SOMETHING until then (ISO 8601). The client keeps it as pending —
   * counted, listed, reachable without the notification — until it is answered, expires, or its
   * module says it is resolved. Absent: an ordinary notice, forgotten once shown.
   *
   * Typed rather than hidden in `data`, because the service worker INTERPRETS it, and an opaque
   * field with a meaning is a contract without a name. Its one consumer is the ask. ADR-0010.
   */
  readonly until?: string
}

/**
 * What the KERNEL serialises into the push payload. A module never builds one.
 *
 * The service worker composes the visible title from `machine` and `message.title`, so
 * neither the kernel nor a module rewrites text it does not own.
 */
export interface PushEnvelope {
  readonly message: NotificationMessage
  /**
   * `null` IS THE DAEMON ITSELF — used by exactly one notice, a new subscription, which is
   * raised by a kernel route with no module behind it. Not a reserved string: `moduleIdSchema`
   * would accept one as a real module id, and a module so named could forge daemon notices.
   */
  readonly moduleId: string | null
  /** From the hostname of `publicOrigin`, which only `boot` knows. */
  readonly machine: string
}

/**
 * What `boot` returns. `boot` NEVER calls `process.exit`: it throws `BootError` and
 * the CLI decides the exit code, which is what lets the abort paths be tested
 * in-process instead of by spawning a subprocess.
 */
export interface BootHandle {
  /**
   * THE PUBLIC ORIGIN: where a browser reaches this daemon, through whatever is
   * terminating TLS in front. Taken from the config, not composed from the bind.
   * This is what goes in the QR and what `start` prints.
   */
  readonly url: string
  /**
   * Where the process ACTUALLY listens, canonical and checked against the socket in
   * step 11.
   *
   * These two names are similar and the values are not, so: `url` is for anything
   * that has to travel to another device, `localUrl` is for anything on this machine
   * that must keep working when the proxy does not. The permission hook is the second
   * kind — it runs beside the daemon, and a gate decision that depends on
   * `tailscale serve` being alive is a gate that fails at the worst moment.
   *
   * Note this is NOT the same thing as `OriginPolicy.localOrigin`, which is
   * `undefined` when the bind is not loopback. This one is always defined: it
   * describes where the socket is, not what the policy accepts. Deriving either from
   * the other re-opens the hole `net/policy.ts` exists to close.
   */
  readonly localUrl: string
  /** Stops modules in reverse order, disposes their timers, closes the server. */
  readonly stop: () => Promise<void>
}

/**
 * A module whose config type is not known where modules are collected.
 *
 * `any` and not `unknown`, deliberately: `C` appears in an INPUT position —
 * `ModuleContext<C>` is the argument of `routes` and `start` — which makes
 * `FactotumModule<C>` invariant in `C`. A heterogeneous list therefore cannot be
 * typed as `FactotumModule<unknown>[]`, and TypeScript has no existential types to
 * express "some C" properly.
 *
 * The safety is not lost, only moved: `composeModules` parses each fragment with
 * that module's own schema, so by the time a value reaches `ctx.config` it has been
 * validated by the only thing that knows its shape.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyModule = FactotumModule<any>

/** How a module ended up in the registry. */
export type ModuleStatus =
  | { readonly kind: 'enabled' }
  | { readonly kind: 'disabled'; readonly reason: string }
