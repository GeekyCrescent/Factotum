/**
 * The thirteen steps, in order.
 *
 * The order is the design. Nothing touches the network or the disk on a module's
 * behalf until the bind is proven, and nothing is served until everything that could
 * still fail has failed.
 *
 * `boot` NEVER calls `process.exit`. It throws `BootError` and the CLI decides the
 * exit code — which is what lets every abort path be tested in-process.
 */

import type { Server } from 'node:http'
import { networkInterfaces } from 'node:os'
import type { AddressInfo } from 'node:net'
import { prefixed, type AnyModule, type BootHandle, type Environment } from '@factotum/core'
import { createPushService } from './push/service.ts'
import { BootError } from './errors.ts'
import { loadRootConfig, composeModules } from './config/load.ts'
import { ensureStateRoots, statePaths, type StatePaths } from './config/paths.ts'
import { resolveListen, type Interfaces } from './net/resolve.ts'
import { verifyBound } from './net/verify.ts'
import { localUrl } from './net/url.ts'
import { policyFor } from './net/policy.ts'
import { Registry } from './modules/registry.ts'
import { createServer, type ServerDeps, type StaticSite } from './http/server.ts'

export interface BootOptions {
  readonly env: Environment
  readonly modules: readonly AnyModule[]
  readonly version: string
  readonly home?: string
  readonly site?: StaticSite
  readonly interfaces?: Interfaces
  readonly startTimeoutMs?: number
  readonly paths?: StatePaths
  /**
   * A seam, and the only one. Step 11 asks what the socket ACTUALLY bound to, and
   * the only way to exercise the failure is a server that reports something else.
   * Injecting it here beats the alternatives: a flag that disables validation would
   * be a flag an operator could find, and leaving the branch untested would leave
   * the one check that makes "no credential" defensible unproven.
   */
  readonly makeServer?: (deps: ServerDeps) => Server
}

export async function boot(options: BootOptions): Promise<BootHandle> {
  const startedAt = Date.now()

  // 1-3. Environment, config, and the cross-check that catches a copied config.
  const paths = options.paths ?? statePaths(options.env, options.home)
  const config = await loadRootConfig(options.env, paths)

  // 4-5. Where to listen, and whether we are allowed to.
  const listen = resolveListen(config.listen, options.interfaces)

  // 6. Which modules run. Duplicate ids abort; a bad fragment disables one module.
  const composed = composeModules(options.modules, config.modules)

  // 7. State roots.
  await ensureStateRoots(paths)

  // 7 bis. Push, BETWEEN 7 AND 8 and not later. Step 8 builds every module's context, and a
  // context carries `notify`; there is nothing to hand over if this has not happened. It reads
  // and — on a first start — creates the VAPID pair, and it sends NOTHING: a boot that needed
  // the internet would be a boot that fails on a plane. Never throws: push off is a degraded
  // capability, not an abort (ADR-0004).
  const push = await createPushService({
    dir: paths.push,
    machine: machineName(config.publicOrigin),
    // The VAPID `sub` claim wants an https: URL or a mailto:. `publicOrigin` is the https:
    // name this daemon answers on. In dev it is a loopback http: origin — and dev cannot
    // subscribe (no secure context), so nothing is ever sent there to object to it.
    subject: config.publicOrigin,
    log: prefixed('push'),
  })

  // 8. Contexts and route tables. Still nothing running.
  const registryDeps = {
    paths,
    env: options.env,
    push,
    ...(options.startTimeoutMs !== undefined ? { startTimeoutMs: options.startTimeoutMs } : {}),
  }
  const registry = await Registry.create(composed, registryDeps)

  // 9. Mount.
  let ready = false
  const make = options.makeServer ?? createServer
  const server = make({
    registry,
    // `listen.address` is the RESOLVED address from step 4, not what the config
    // declared — with `listen.interface` those differ, and passing the declared one
    // would decide the rescue route from a value that was never bound.
    origin: policyFor({
      publicOrigin: config.publicOrigin,
      address: listen.address,
      port: listen.port,
      extraOrigins: config.listen.extraOrigins,
    }),
    env: options.env,
    version: options.version,
    startedAt,
    push,
    // `main.ts` injects none: without the default, prod would compare against nothing.
    interfaces: options.interfaces ?? networkInterfaces,
    ...(options.site !== undefined ? { site: options.site } : {}),
    isReady: () => ready,
  })

  // 10. Listen.
  await listenOrExplain(server, listen.address, listen.port, options.env)

  // 11. What ACTUALLY happened. Steps 4 and 5 validated the intention; this is the
  // only thing that catches a wide bind arriving from a platform default or from a
  // refactor years from now — and it is what makes shipping no credential rest on
  // something checked rather than something believed.
  const actual = server.address() as AddressInfo | null
  const verdict = verifyBound({ address: listen.address, port: listen.port }, actual)
  if (!verdict.ok) {
    await close(server)
    await registry.stopAll()
    throw new BootError(
      'bind-mismatch',
      `meant to listen on ${verdict.expected} but ended up on ${verdict.actual}`,
      'this should not be possible; please open an issue with `factotum doctor` output',
    )
  }

  // 12. Only now does anything of a module's start running.
  await registry.startAll()

  // 13. Ready. Everything before this answered 503 on the API.
  ready = true

  return {
    // Declared, not composed. The daemon cannot know the name the certificate in
    // front of it covers, and a URL guessed from the bind would be a loopback
    // address in the QR.
    url: config.publicOrigin,
    localUrl: localUrl(listen.address, listen.port),
    stop: async () => {
      ready = false
      await registry.stopAll()
      // Notices already on their way — a module's "stopped" among them — are let finish. Each
      // is bounded by its own AbortSignal, so this cannot hang the shutdown.
      await push.settled()
      await close(server)
    },
  }
}

/**
 * The first label of the public hostname: `juans-macbook-pro`, not the whole
 * `juans-macbook-pro.tailbd0167.ts.net`. It is what tells two machines' notices apart on a
 * phone, and a notification title has no room for a tailnet suffix.
 */
function machineName(publicOrigin: string): string {
  return new URL(publicOrigin).hostname.split('.')[0] ?? publicOrigin
}

function listenOrExplain(
  server: Server,
  address: string,
  port: number,
  env: Environment,
): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') {
        reject(
          new BootError(
            'port-in-use',
            `port ${port} is already in use, so the ${env} environment cannot start`,
            `stop whatever is on ${port}, or give this environment a different ` +
              '`listen.port` — dev and prod are meant to run side by side',
          ),
        )
        return
      }
      reject(error)
    })
    server.listen(port, address, () => resolve())
  })
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()))
}
