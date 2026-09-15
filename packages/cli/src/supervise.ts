/**
 * Keeping the daemon up across logins, with launchd.
 *
 * THIS WRAPS `factotum start`; IT DOES NOT CHANGE IT. `start` already does everything
 * a supervisor needs — holds the process open, handles SIGTERM, and exits non-zero
 * when `boot` fails — so there is nothing to add to it and `factotum start` in a
 * terminal keeps behaving exactly as before.
 *
 * It does NOT start `tailscale serve`. That is one command the owner runs once, and
 * silently managing someone else's daemon is how a tool becomes something you have to
 * reverse-engineer before you can trust it.
 *
 * Composing the plist is separated from writing it so the decisions below are
 * testable without touching `~/Library/LaunchAgents`.
 */

import { join } from 'node:path'
import type { Environment } from '@factotum/core'

export interface PlistInput {
  readonly env: Environment
  /** Absolute path to the node binary. A LaunchAgent gets no PATH worth the name. */
  readonly nodePath: string
  /** Absolute path to the CLI entry point. */
  readonly mainPath: string
  /** `StatePaths.root` — there is no `stateDir`; logs go under the env's root. */
  readonly stateRoot: string
  /**
   * The PATH to hand the job, captured from the installing shell.
   *
   * `packages/sessions/src/run.ts` launches `claude` BY NAME. A LaunchAgent inherits
   * launchd's minimal PATH, not a login shell's, so without this the daemon comes up
   * perfectly, answers /health, and every single session dies with ENOENT. The
   * `factotum install` check does not catch it — the daemon IS up — which is why
   * there is a separate criterion for launching a real session under launchd.
   */
  readonly path: string
}

/** One label per environment, or installing dev would evict prod. */
export function labelFor(env: Environment): string {
  return `com.factotum.${env}`
}

export function plistPath(home: string, env: Environment): string {
  return join(home, 'Library', 'LaunchAgents', `${labelFor(env)}.plist`)
}

/** launchd does NOT create these. See `logDir`. */
export function logPaths(stateRoot: string): { readonly out: string; readonly err: string } {
  return { out: join(stateRoot, 'daemon.log'), err: join(stateRoot, 'daemon.err.log') }
}

/** The directory that must exist BEFORE the job is loaded. */
export function logDir(stateRoot: string): string {
  return stateRoot
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/**
 * The plist, as a string. Pure: same input, same bytes.
 *
 * TWO KEYS ARE EASY TO GET WRONG AND BOTH HAVE BEEN GOT WRONG:
 *
 * `KeepAlive` is a DICTIONARY, not `true`. As a boolean, launchd keeps the job alive
 * unconditionally — so a config the daemon refuses to start on becomes a restart loop
 * that burns CPU and hides the error. `{ Crashed: true }` relaunches a job that died
 * on a signal and leaves one that exited cleanly with 1 down, VISIBLY, which is what
 * a config error should look like.
 *
 * `RunAtLoad` must be `true` ALONGSIDE it. This is the regression: with a boolean
 * KeepAlive, launchd starts the job on load as a side effect of keeping it alive, and
 * switching to the dictionary form takes that away. Without `RunAtLoad` the job is
 * then loaded and never started — so it survives a crash but does NOT come up at
 * login, which is the entire reason for installing it.
 */
export function composePlist(input: PlistInput): string {
  const logs = logPaths(input.stateRoot)
  const args = [input.nodePath, input.mainPath, 'start', '--env', input.env]

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${labelFor(input.env)}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${escapeXml(a)}</string>`).join('\n')}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>Crashed</key>
    <true/>
  </dict>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${escapeXml(input.path)}</string>
    <key>FACTOTUM_ENV</key>
    <string>${input.env}</string>
  </dict>
  <key>StandardOutPath</key>
  <string>${escapeXml(logs.out)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(logs.err)}</string>
  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
`
}

/**
 * `bootstrap` and `bootout` are NOT symmetric, and this is where the first attempt
 * fails.
 *
 *   bootstrap  gui/<uid>  <PATH TO THE PLIST FILE>
 *   bootout    gui/<uid>/<LABEL>          <- a service target, not a path
 *
 * `load`/`unload` have been deprecated since 10.11. `launchctl list` is still the
 * right way to ask whether a job is registered.
 */
export function bootstrapArgs(uid: number, plist: string): readonly string[] {
  return ['bootstrap', `gui/${uid}`, plist]
}

export function bootoutArgs(uid: number, env: Environment): readonly string[] {
  return ['bootout', `gui/${uid}/${labelFor(env)}`]
}
