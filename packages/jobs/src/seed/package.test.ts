import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

import { parseKit } from './kit.ts'
import { parsePackage, type PackageEntry } from './package.ts'

const fixture = (name: string) => readFile(new URL(`../../test/fixtures/${name}`, import.meta.url), 'utf8')
const kit = parseKit(await fixture('kit.md'))
const ads = parsePackage('02-ads.md', await fixture('package-ads.md'), kit)

const entry = (entries: readonly PackageEntry[], n: number): PackageEntry => {
  const found = entries.find((candidate) => candidate.n === n)
  assert.ok(found, `no entry ${n}`)
  return found
}

// ── S4a: the ads shape (file 02) ───────────────────────────────────────────────────────────────────

test('ads: every "## N. Company" up to the next --- is an entry', () => {
  assert.deepEqual(
    ads.entries.map((e) => [e.n, e.company]),
    [
      [1, 'Kestrel Freight'],
      [2, 'Bluegum Analytics'],
      [3, 'Tern Labs (platform / freelance)'],
      [4, 'Gannet AI (platform / freelance)'],
      [5, 'Petrel Payments'],
      [6, 'Shearwater University (expression of interest — ad closed)'],
      [7, 'Ironbark Data'],
    ],
  )
  assert.equal(ads.file, '02-ads.md')
})

test('ads: channel and target from Send via', () => {
  const seek = entry(ads.entries, 1)
  assert.equal(seek.channel, 'platform')
  assert.equal(seek.target.url, 'https://www.seek.com.au/job/10000001')
  const ashby = entry(ads.entries, 2)
  assert.equal(ashby.channel, 'form')
  assert.equal(ashby.target.url, 'https://jobs.ashbyhq.com/bluegum/0a1b2c3d-0000-4000-8000-000000000001')
  assert.equal(entry(ads.entries, 3).channel, 'form')
  assert.equal(entry(ads.entries, 3).target.url, 'https://aggregator.example/jobs/tern-labs-software-developers-12345')
  assert.equal(entry(ads.entries, 4).target.url, 'https://gannet.example')
  assert.equal(entry(ads.entries, 7).target.url, 'https://app.dover.com/apply/ironbark/00000000-1111-4222-8333-444444444444')
})

test('ads: an email whose address is a **[…]** placeholder stays email, with the placeholder as to', () => {
  const email = entry(ads.entries, 6)
  assert.equal(email.channel, 'email')
  assert.equal(email.target.to, '[Careers or IT recruitment email — TODO, owner to find]')
})

test('ads: Contact, Role, CV version and Ad status', () => {
  const first = entry(ads.entries, 1)
  assert.equal(first.contact, 'Robin Vale — Operations Director (named on the company site)')
  assert.equal(first.role, 'Software Developer – Logistics Tools (Part-Time / Casual)')
  assert.equal(first.cvBase, 'B')
  assert.equal(first.adStatus, 'live, posted 20 days ago. Apply today.')
  assert.equal(entry(ads.entries, 7).cvBase, 'A')
})

test('ads: the cover letter is the blockquote after **Cover letter**, without "> "', () => {
  const body = entry(ads.entries, 1).letter?.body ?? ''
  assert.ok(body.startsWith('Hi Robin,\n\nYour ad asks for someone'))
  assert.ok(body.includes('- **"React and Postgres."** I built every screen'))
  assert.ok(!/^>/m.test(body))
  assert.equal(entry(ads.entries, 1).letter?.subject, null)
})

test('ads: the other body headings (profile summary, cover letter / email, expression of interest) are the letter too', () => {
  assert.ok(entry(ads.entries, 3).letter?.body.startsWith('Software engineer and current postgraduate student.'))
  assert.ok(entry(ads.entries, 4).letter?.body.startsWith('Software engineer with production LLM work'))
  assert.ok(entry(ads.entries, 5).letter?.body.startsWith('Hi Petrel team,'))
  assert.equal(entry(ads.entries, 5).letter?.subject, 'Internship application — Web Development, January–June 2027')
  assert.ok(entry(ads.entries, 6).letter?.body.startsWith('Hi Shearwater Careers team,'))
})

test('ads: likely form questions become form[], with kit cites resolved and their hint', () => {
  assert.deepEqual(entry(ads.entries, 1).form, [
    { question: 'Why do you want to work here?', answer: 'You need one person who can own a live tool and the integrations around it.', hint: null },
    { question: 'Right to work in Australia?', answer: kit.sections.get(2)?.[0]?.answer, hint: null },
    {
      question: 'Notice required for your current employer?',
      answer: 'I can start on 12 January 2027.',
      hint: '"I can start on 12 January 2027" — confirm with your employer first',
    },
    { question: 'GitHub / portfolio link?', answer: '{portfolio}', hint: null },
  ])
  const second = entry(ads.entries, 2).form
  assert.equal(second[0]?.hint, 'consent to the background check')
  assert.equal(second[1]?.answer, 'Yes, from 12 January 2027 (or by video before then).')
  assert.equal(second[1]?.hint, 'see [[00-kit-base]] §6 for December travel')
  assert.equal(second[2]?.answer, "about 1. Don't round up.")
  assert.equal(second[3]?.answer, 'I live in Sydney {suburb} and can commute to the office or work hybrid.')
  assert.equal(second[4]?.answer, '{rate}')
  assert.ok(second[5]?.answer.includes('{timezone}'))
})

test('ads: each resolved cite is listed for the report, with the question it matched', () => {
  assert.deepEqual(entry(ads.entries, 1).kitRefs, [
    { question: 'Right to work in Australia?', section: 2, matched: 'Do you have the right to work in Australia?', ambiguous: false },
    { question: 'Notice required for your current employer?', section: 6, matched: 'Notice period', ambiguous: false },
  ])
})

test('ads: [GitHub/portfolio link — TODO] becomes {portfolio} in letter, answers and LinkedIn note, with or without backticks', () => {
  const first = entry(ads.entries, 1)
  assert.equal(first.form[3]?.answer, '{portfolio}')
  assert.ok(first.linkedin?.includes('Portfolio: {portfolio}.'))
  const second = entry(ads.entries, 2)
  assert.ok(second.letter?.body.includes('Portfolio: {portfolio}'))
  assert.equal(second.form[6]?.answer, '{portfolio}')
})

test('ads: notes keep the portfolio TODO as it is (notes are never sent)', () => {
  assert.ok(entry(ads.entries, 1).notes.includes('[GitHub/portfolio link — TODO]'))
  assert.ok(!entry(ads.entries, 1).notes.includes('{portfolio}'))
})

test('ads: Skills to tick split by " · " and Do not tick by ", ", without the final dot', () => {
  assert.deepEqual(entry(ads.entries, 3).skills, {
    tick: ['TypeScript', 'JavaScript', 'Python', 'SQL', 'testing (Vitest, Playwright)'],
    doNotTick: ['Swift', 'Xcode', 'Go'],
  })
  assert.deepEqual(entry(ads.entries, 4).skills, {
    tick: ['AI agents / tool use', 'prompt engineering', 'Python'],
    doNotTick: ['Go', 'Rust', 'Kubernetes'],
  })
  assert.equal(entry(ads.entries, 1).skills, null)
})

test('ads: the LinkedIn note in a blockquote', () => {
  assert.equal(entry(ads.entries, 2).linkedin, "Hi Pat — I've applied for the Graduate Data Engineer role. Keen to talk.")
  assert.equal(entry(ads.entries, 3).linkedin, null)
})

test('ads: owner notes are the notes', () => {
  assert.equal(entry(ads.entries, 2).notes, '- The ad is listed part-time; ask about hybrid days early.')
  assert.equal(entry(ads.entries, 3).notes, '- Independent contractor: needs an ABN.')
})

test('ads: nothing is missing in a complete entry; an entry without a body or role says so', () => {
  assert.deepEqual(entry(ads.entries, 1).missing, [])
  const bare = parsePackage('x.md', '## 1. Bare Co\n\n- **Send via:** https://bare.example/careers\n\n---\n', kit)
  assert.deepEqual(bare.entries[0]?.missing, ['role', 'cvBase', 'body'])
  const noSendVia = parsePackage('x.md', '## 1. Bare Co\n\n- **Role:** Dev · **CV version:** A\n\n> Hi.\n', kit)
  assert.deepEqual(noSendVia.entries[0]?.missing, ['sendVia'])
  assert.equal(noSendVia.entries[0]?.channel, 'form')
})
