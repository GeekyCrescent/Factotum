/**
 * Turning a module's `RouteTable` into something that can answer a request.
 *
 * A module never registers anything outside its own prefix, and that is not a
 * promise it keeps — it is that there is nowhere to write it. The prefix is applied
 * here, from an id the registry has already validated as unique and well-shaped.
 */

import type { ModuleRequest, RouteHandler, RouteTable } from '@factotum/core'
import { BootError } from '../errors.ts'

interface Segment {
  readonly literal?: string
  readonly param?: string
}

export interface CompiledRoute {
  readonly method: string
  readonly key: string
  readonly segments: readonly Segment[]
  readonly handler: RouteHandler
}

const KEY = /^([A-Z]+) (\/\S*)$/

/**
 * Route keys are checked when the daemon starts, not on the first request that hits
 * a bad one. A typo in a route key is a programming error, and finding it three days
 * later in a log is the expensive way.
 */
export function compileRoutes(moduleId: string, table: RouteTable): readonly CompiledRoute[] {
  const compiled: CompiledRoute[] = []

  for (const [key, handler] of Object.entries(table)) {
    const match = KEY.exec(key)
    if (match === null) {
      throw new BootError(
        'route-key-invalid',
        `module "${moduleId}" declares route ${JSON.stringify(key)}`,
        'route keys look like "GET /things/:id" — an upper-case method, a space, then a path',
      )
    }

    const [, method, path] = match as unknown as [string, string, string]
    const segments: Segment[] = []
    const names = new Set<string>()

    for (const raw of path.split('/').filter((part) => part !== '')) {
      if (raw.startsWith(':')) {
        const param = raw.slice(1)
        if (param === '') {
          throw new BootError(
            'route-key-invalid',
            `module "${moduleId}" declares a nameless parameter in ${JSON.stringify(key)}`,
            'write the name, as in "/things/:id"',
          )
        }
        // `params` is a flat record, so the second would silently shadow the first.
        // The predecessor project avoids this by naming them `calendarId` and
        // `eventId`; here the shape makes forgetting impossible.
        if (names.has(param)) {
          throw new BootError(
            'route-key-invalid',
            `module "${moduleId}" uses :${param} twice in ${JSON.stringify(key)}`,
            'give each parameter its own name, as in "/calendars/:calendarId/events/:eventId"',
          )
        }
        names.add(param)
        segments.push({ param })
      } else {
        segments.push({ literal: raw })
      }
    }

    compiled.push({ method, key, segments, handler })
  }

  // Literal segments beat parameters, deterministically, whatever order the module
  // wrote them in — a `Record` has no contractual iteration order, so leaving this
  // to the author would make `/places/new` work or not depending on how they typed.
  return compiled.sort(compare)
}

function compare(a: CompiledRoute, b: CompiledRoute): number {
  const length = Math.max(a.segments.length, b.segments.length)
  for (let i = 0; i < length; i += 1) {
    const left = a.segments[i]
    const right = b.segments[i]
    if (left === undefined || right === undefined) continue
    const leftLiteral = left.literal !== undefined
    const rightLiteral = right.literal !== undefined
    if (leftLiteral !== rightLiteral) return leftLiteral ? -1 : 1
  }
  return 0
}

export interface Matched {
  readonly handler: RouteHandler
  readonly params: Record<string, string>
}

export function matchRoute(
  routes: readonly CompiledRoute[],
  method: string,
  path: string,
): Matched | undefined {
  const parts = path.split('/').filter((part) => part !== '')

  for (const route of routes) {
    if (route.method !== method) continue
    if (route.segments.length !== parts.length) continue

    const params: Record<string, string> = {}
    let ok = true

    for (const [i, segment] of route.segments.entries()) {
      const part = parts[i]!
      if (segment.literal !== undefined) {
        if (segment.literal !== part) {
          ok = false
          break
        }
      } else {
        // Decoded here so a module never has to remember to. In the predecessor the
        // ids that travel in a path are things like an email address, and its router
        // carries the note that they arrive escaped.
        params[segment.param!] = decodeURIComponent(part)
      }
    }

    if (ok) return { handler: route.handler, params }
  }

  return undefined
}

export function buildRequest(
  method: string,
  path: string,
  params: Record<string, string>,
  query: URLSearchParams,
  body: unknown,
): ModuleRequest {
  return {
    method,
    path: path.startsWith('/') ? path : `/${path}`,
    params,
    query: Object.fromEntries(query.entries()),
    body,
  }
}
