/**
 * Test doubles, under the `@factotum/jobs/testing` subpath so no production code imports them (as
 * `@factotum/mail/testing`). For the composition root's tests (`packages/cli`), which see the module
 * and the engine together: a synthetic vault, a config pointing at it and at the fake binaries, the
 * fixture clock, timers a test fires by hand, and polling. ALL SYNTHETIC. Excluded from coverage.
 */

export { NOW, rigIn, type Rig } from './test-jobs.ts'
export { FAKE_CLAUDE } from './build/test-builder.ts'
export { eventually, manualClock, manualTimers, type ManualClock, type ManualTimers } from './test-support.ts'
