/**
 * YOUR modules go here.
 *
 * Adding one is a line in this file: import it, and put it in the array. That is the
 * price of a static registry, and it buys the thing that matters — a module that does
 * not satisfy `FactotumModule` fails to COMPILE rather than failing at runtime, and
 * the client bundler can see it.
 *
 * This file is versioned and ships empty, so a fork carries a one-line diff forever.
 * That is deliberate: the alternative — a directory convention with dynamic imports —
 * costs the type checking, which is the whole value of the contract.
 *
 * Enabling a module is NOT done here. That is `modules.<id>.enabled` in
 * `~/.factotum/<env>/config.json`, and it needs no rebuild.
 */

import type { AnyModule } from '@factotum/core'

export const LOCAL: readonly AnyModule[] = []
