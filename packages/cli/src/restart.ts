/**
 * Restarting the daemon after its config changed — when this machine's supervisor is
 * one factotum knows.
 *
 * It NEVER pretends. If the job is not loaded, or this is not macOS, it says what to
 * run instead: a command that claims to have restarted something it did not is worse
 * than one that asks you to type a line, because the config change silently does not
 * take effect until the next reboot.
 */

import type { Environment } from '@factotum/core'
import { execRunner, type Runner } from './tailscale.ts'
import { labelFor } from './supervise.ts'

export interface RestartDeps {
  readonly env: Environment
  readonly out: (line: string) => void
  readonly run?: Runner
  readonly uid?: number
  readonly platform?: NodeJS.Platform
}

export type RestartOutcome = 'restarted' | 'not-supervised' | 'unsupported'

export async function restartDaemon(deps: RestartDeps): Promise<RestartOutcome> {
  const run = deps.run ?? execRunner
  const platform = deps.platform ?? process.platform
  const label = labelFor(deps.env)

  if (platform !== 'darwin') {
    deps.out(`config changed. Restart the daemon yourself — on ${platform} factotum does not`)
    deps.out('know your supervisor: `systemctl --user restart <unit>`, or restart `factotum start`.')
    return 'unsupported'
  }

  const uid = deps.uid ?? process.getuid?.() ?? 0
  const loaded = await run('launchctl', ['print', `gui/${uid}/${label}`])
  if (loaded.code !== 0) {
    // Not installed is the normal case for someone running `factotum start` by hand.
    deps.out('config changed. Nothing to restart: this environment is not installed as a')
    deps.out(`LaunchAgent. Restart \`factotum start\` for it to take effect.`)
    return 'not-supervised'
  }

  // `kickstart -k` kills and restarts in one step, which is what a config change wants:
  // an in-flight session is cancelled with its reason and resumes on the next message.
  const result = await run('launchctl', ['kickstart', '-k', `gui/${uid}/${label}`])
  if (result.code !== 0) {
    deps.out(`could not restart ${label} (exit ${String(result.code)}).`)
    deps.out(`  try:  launchctl kickstart -k gui/${uid}/${label}`)
    return 'not-supervised'
  }

  deps.out(`restarted ${label}`)
  return 'restarted'
}
