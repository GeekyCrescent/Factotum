/**
 * The handoff's numbers (spec 2026-10-07-dos-hosts, D7–D11). ONE PLACE: the design's tables refer
 * here by name, and a test that needs another value passes its own instead of changing these.
 */

/** «All the sessions» are the ones touched in the last 24 h (requirements S1, `touchedOf`). */
export const HANDOFF_WINDOW_HOURS = 24

/** The kernel's upload ceiling (ADR-0012, amended): no file of a session travels if it is larger. */
export const HANDOFF_FILE_MAX_BYTES = 256 * 1024 * 1024

/** Node cuts a request at 300 s; 240 s leaves the margin (D7, `too-slow-to-send`). */
export const HANDOFF_FILE_MAX_SECONDS = 240

/** A5 measured 12.9 MB/s through `tailscale serve`; half of it, for margin (tasks §M). */
export const HANDOFF_ASSUMED_MBPS = 6

/** The calls to the peer that read its repos: the preview, `POST /handoff` and `doctor` (v4.3). */
export const HANDOFF_PEER_READ_TIMEOUT_MS = 120_000

/** How long a finished preview is kept in memory (D7). */
export const HANDOFF_PREVIEW_KEEP_MS = 10 * 60_000

/** The target's `prepared` dies after this long without a signal from the source (D9, criterion 30b). */
export const HANDOFF_PREPARED_TTL_MS = 15 * 60_000

/** Backups and rescues are pruned after this many days (guardrail 5, D11). */
export const HANDOFF_BACKUP_DAYS = 14

/** The paths of `target-ignored-collision` that travel, at most (D8). */
export const HANDOFF_PATHS_MAX = 50
