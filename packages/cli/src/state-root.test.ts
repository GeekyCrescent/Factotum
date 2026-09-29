import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dirname } from 'node:path'
import { ENVIRONMENTS } from '@factotum/core'
import { moduleStateDir, statePaths } from '@factotum/kernel'
import { factotumRootOf } from '@factotum/modules'

/**
 * THE COMPOSITION ROOT IS THE ONE PLACE THAT SEES BOTH SIDES, so this is where the module's idea of
 * `~/.factotum` is checked against the kernel's layout (spec 2026-09-29, D1).
 *
 * `~/.factotum`, NOT `~/.factotum/<env>`: the rule it feeds refuses what is inside or above it as a
 * project, and a root one level too deep would let prod register `~/.factotum/dev` — another
 * daemon's state, with its hook settings — as a folder an agent may write.
 */
test('the module’s factotumRoot is the parent of every environment’s state root', () => {
  const home = '/Users/someone'
  for (const env of ENVIRONMENTS) {
    const kernel = statePaths(env, home)
    assert.equal(factotumRootOf(moduleStateDir(kernel, 'sessions')), dirname(kernel.root), env)
    assert.notEqual(factotumRootOf(moduleStateDir(kernel, 'sessions')), kernel.root, `${env}: not one level too deep`)
  }
})
