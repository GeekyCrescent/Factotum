import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseJobsConfig } from './config.ts'

/** design D13, the host block as the owner writes it (minus the defaults). */
function hostBlock(): Record<string, unknown> {
  return {
    mode: 'host',
    timeZone: 'Australia/Sydney',
    vault: {
      root: '/home/ferro/Ferro/Obsidian',
      cvMaster: '03-life/carrera/cv-maestro.md',
      guide: '03-life/carrera/guia-para-el-agente.md',
      seed: {
        companies: '03-life/carrera/postulaciones/datos/empresas-2026-11-10.json',
        kit: '03-life/carrera/postulaciones/paquete-2027/00-kit-base.md',
        cvs: '03-life/carrera/postulaciones/paquete-2027/01-cvs.md',
        packages: [
          { file: '03-life/carrera/postulaciones/paquete-2027/02-postulaciones-anuncios.md' },
          { file: '03-life/carrera/postulaciones/paquete-2027/03-emails-ola-1.md', byHand: true },
          { file: '03-life/carrera/postulaciones/paquete-2027/04-emails-ola-2.md', holdUntil: '2027-01-12' },
        ],
      },
    },
    mail: {
      address: 'ferro.rayon@gmail.com',
      displayName: 'Juan Rodrigo Ferro Rayón',
      passwordFile: '/home/ferro/.factotum/secrets/gmail-jobs',
    },
    chromium: '/usr/lib/chromium/chromium',
    poppler: { pdfinfo: '/usr/bin/pdfinfo', pdftoppm: '/usr/bin/pdftoppm' },
  }
}

function withPath(path: readonly (string | number)[], value: unknown): Record<string, unknown> {
  const root = structuredClone(hostBlock())
  let at: Record<string | number, unknown> = root
  for (const key of path.slice(0, -1)) at = at[key] as Record<string | number, unknown>
  const last = path[path.length - 1] as string | number
  if (value === undefined) delete at[last]
  else at[last] = value
  return root
}

test('the host block of D13 parses, with every default filled', () => {
  const parsed = parseJobsConfig(hostBlock())
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.reason)
  if (!parsed.ok || parsed.config.mode !== 'host') return
  assert.equal(parsed.timeZone, 'Australia/Sydney')
  const { config } = parsed
  assert.equal(config.mail.imapHost, 'imap.gmail.com')
  assert.equal(config.mail.smtpHost, 'smtp.gmail.com')
  assert.equal(config.mail.replyPollMinutes, 10)
  assert.equal(config.mail.maxSendsPerDay, 40)
  assert.deepEqual(config.claude, { concurrency: 2, models: { write: 'sonnet', verify: 'sonnet', classify: 'haiku', extract: 'haiku' } })
  assert.equal(config.scout.enabled, false)
  assert.equal(config.scout.dailyAt, '06:30')
  assert.equal(config.scout.politeMs, 5000)
  assert.equal(config.scout.maxPages, 10)
  assert.equal(config.scout.strongMatch, 85)
  assert.deepEqual(config.scout.sources, ['seek', 'wwr', 'remoteok', 'remotive', 'yc', 'ats', 'linkedin-alerts'])
  assert.deepEqual(config.scout.watch, [])
  assert.equal(config.keeper.enabled, false)
  assert.equal(config.keeper.weekday, 'sun')
  assert.equal(config.keeper.at, '20:00')
  assert.equal(config.keeper.syncLock, '/tmp/vault-sync-1000.lock')
  assert.deepEqual(config.keeper.exclude, ['03-life/carrera/cv-maestro.md', '03-life/carrera/postulaciones/'])
  assert.equal(config.vault.seed.packages[1]?.byHand, true)
  assert.equal(config.vault.seed.packages[2]?.holdUntil, '2027-01-12')
  assert.equal(config.vault.seed.packages[0]?.byHand, undefined)
})

test('an empty mode is host, and the zone of the process is the default', () => {
  const parsed = parseJobsConfig(withPath(['timeZone'], undefined))
  assert.ok(parsed.ok)
  if (!parsed.ok) return
  assert.equal(parsed.config.mode, 'host')
  assert.equal(parsed.timeZone, Intl.DateTimeFormat().resolvedOptions().timeZone)
})

test('a scout watch entry with its adapter and window parses', () => {
  const parsed = parseJobsConfig(
    withPath(['scout'], { enabled: true, watch: [{ company: 'Amazon', kind: 'amazon', query: 'intern software sydney', windowMonths: [7, 8, 9] }] }),
  )
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.reason)
})

test('relay names the host that keeps the module, and nothing else', () => {
  const parsed = parseJobsConfig({ mode: 'relay', relayTo: 'omarchy' })
  assert.ok(parsed.ok)
  if (parsed.ok) assert.deepEqual(parsed.config, { mode: 'relay', relayTo: 'omarchy' })
})

// Requirements crit. 1: each bad block switches off jobs alone, with a reason that never carries the value.
const bad: readonly { readonly name: string; readonly raw: unknown; readonly path: string; readonly secret: string }[] = [
  { name: 'not an object', raw: 'host', path: 'jobs', secret: '' },
  { name: 'an unknown key at the top', raw: withPath(['timezone'], 'Mars/Olympus'), path: 'jobs', secret: 'Mars/Olympus' },
  { name: 'an unknown key in vault', raw: withPath(['vault', 'cvMastr'], 'secret-path.md'), path: 'jobs.vault', secret: 'secret-path' },
  { name: 'an unknown key in a package', raw: withPath(['vault', 'seed', 'packages', 0, 'byhand'], true), path: 'jobs.vault.seed.packages.0', secret: '' },
  { name: 'an unknown key in mail', raw: withPath(['mail', 'password'], 'hunter2-secret'), path: 'jobs.mail', secret: 'hunter2' },
  { name: 'a zone Intl does not accept', raw: withPath(['timeZone'], 'Mars/Olympus'), path: 'jobs.timeZone', secret: 'Mars/Olympus' },
  { name: 'a mode that does not exist', raw: withPath(['mode'], 'mirror-mode'), path: 'jobs.mode', secret: 'mirror' },
  { name: 'a relative vault root', raw: withPath(['vault', 'root'], 'Ferro/Obsidian-secret'), path: 'jobs.vault.root', secret: 'Obsidian-secret' },
  { name: 'a vault root with ..', raw: withPath(['vault', 'root'], '/home/../etc-secret'), path: 'jobs.vault.root', secret: 'etc-secret' },
  { name: 'an absolute cvMaster', raw: withPath(['vault', 'cvMaster'], '/etc/secret-cv.md'), path: 'jobs.vault.cvMaster', secret: 'secret-cv' },
  { name: 'a cvMaster with ..', raw: withPath(['vault', 'cvMaster'], '../outside-secret.md'), path: 'jobs.vault.cvMaster', secret: 'outside-secret' },
  { name: 'a seed path with ..', raw: withPath(['vault', 'seed', 'kit'], 'a/../../kit-secret.md'), path: 'jobs.vault.seed.kit', secret: 'kit-secret' },
  {
    name: 'a package file with ..',
    raw: withPath(['vault', 'seed', 'packages', 0, 'file'], '../pkg-secret.md'),
    path: 'jobs.vault.seed.packages.0.file',
    secret: 'pkg-secret',
  },
  {
    name: 'a holdUntil that is not a day',
    raw: withPath(['vault', 'seed', 'packages', 2, 'holdUntil'], '2027-02-30'),
    path: 'jobs.vault.seed.packages.2.holdUntil',
    secret: '2027-02-30',
  },
  { name: 'a byHand that is not a boolean', raw: withPath(['vault', 'seed', 'packages', 0, 'byHand'], 'yes-secret'), path: 'jobs.vault.seed.packages.0.byHand', secret: 'yes-secret' },
  { name: 'a relative passwordFile', raw: withPath(['mail', 'passwordFile'], 'secrets/gmail-secret'), path: 'jobs.mail.passwordFile', secret: 'gmail-secret' },
  { name: 'a passwordFile with ..', raw: withPath(['mail', 'passwordFile'], '/home/../gmail-secret'), path: 'jobs.mail.passwordFile', secret: 'gmail-secret' },
  { name: 'a mail address that is not one', raw: withPath(['mail', 'address'], 'not-an-address-secret'), path: 'jobs.mail.address', secret: 'not-an-address' },
  { name: 'a host name with a slash', raw: withPath(['mail', 'smtpHost'], 'smtp.example.com/evil-secret'), path: 'jobs.mail.smtpHost', secret: 'evil-secret' },
  { name: 'a host name that is a flag', raw: withPath(['mail', 'imapHost'], '-oProxy-secret'), path: 'jobs.mail.imapHost', secret: 'oProxy' },
  { name: 'zero sends per day', raw: withPath(['mail', 'maxSendsPerDay'], 0), path: 'jobs.mail.maxSendsPerDay', secret: '' },
  { name: 'a relative chromium', raw: withPath(['chromium'], 'chromium-secret'), path: 'jobs.chromium', secret: 'chromium-secret' },
  { name: 'a relative pdfinfo', raw: withPath(['poppler', 'pdfinfo'], 'bin/pdfinfo-secret'), path: 'jobs.poppler.pdfinfo', secret: 'pdfinfo-secret' },
  {
    name: 'a model that is not a model name',
    raw: withPath(['claude'], { models: { write: '--dangerously-skip' } }),
    path: 'jobs.claude.models.write',
    secret: 'dangerously',
  },
  { name: 'a model with a space', raw: withPath(['claude'], { models: { verify: 'opus [1m]' } }), path: 'jobs.claude.models.verify', secret: '[1m]' },
  { name: 'a concurrency of zero', raw: withPath(['claude'], { concurrency: 0 }), path: 'jobs.claude.concurrency', secret: '' },
  { name: 'a scout hour that is not one', raw: withPath(['scout'], { dailyAt: '25:99' }), path: 'jobs.scout.dailyAt', secret: '25:99' },
  { name: 'a scout source that does not exist', raw: withPath(['scout'], { sources: ['gradconnection'] }), path: 'jobs.scout.sources.0', secret: 'gradconnection' },
  {
    name: 'a watch url that is not https',
    raw: withPath(['scout'], { watch: [{ company: 'Acme', url: 'http://acme.example/careers-secret' }] }),
    path: 'jobs.scout.watch.0.url',
    secret: 'careers-secret',
  },
  { name: 'a watch month out of the year', raw: withPath(['scout'], { watch: [{ company: 'Acme', windowMonths: [13] }] }), path: 'jobs.scout.watch.0.windowMonths.0', secret: '' },
  { name: 'a keeper path with ..', raw: withPath(['keeper'], { paths: ['../secret-notes'] }), path: 'jobs.keeper.paths.0', secret: 'secret-notes' },
  { name: 'a relative syncLock', raw: withPath(['keeper'], { syncLock: 'tmp/lock-secret' }), path: 'jobs.keeper.syncLock', secret: 'lock-secret' },
  { name: 'a weekday that does not exist', raw: withPath(['keeper'], { weekday: 'someday' }), path: 'jobs.keeper.weekday', secret: 'someday' },
  { name: 'host mode without vault', raw: withPath(['vault'], undefined), path: 'jobs.vault', secret: '' },
  { name: 'relay without relayTo', raw: { mode: 'relay' }, path: 'jobs.relayTo', secret: '' },
  { name: 'relay with a host field', raw: { mode: 'relay', relayTo: 'omarchy', chromium: '/usr/bin/secret-chromium' }, path: 'jobs', secret: 'secret-chromium' },
  { name: 'relayTo in host mode', raw: withPath(['relayTo'], 'secret-host'), path: 'jobs', secret: 'secret-host' },
  { name: 'a relayTo that is not a machine name', raw: { mode: 'relay', relayTo: 'a/../b-secret' }, path: 'jobs.relayTo', secret: 'b-secret' },
]

for (const { name, raw, path, secret } of bad) {
  test(`${name} is refused with its path, and the reason does not carry the value`, () => {
    const parsed = parseJobsConfig(raw)
    assert.equal(parsed.ok, false)
    if (parsed.ok) return
    assert.ok(parsed.reason.startsWith(`${path}:`), parsed.reason)
    if (secret !== '') assert.ok(!parsed.reason.includes(secret), parsed.reason)
  })
}
