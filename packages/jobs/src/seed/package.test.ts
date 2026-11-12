import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

import { parseKit } from './kit.ts'
import { channelOf, parsePackage, seenOnSite, splitSendVia, type PackageEntry } from './package.ts'

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

// ── S4b: the email shapes (files 03 and 04) ────────────────────────────────────────────────────────

const wave1 = parsePackage('03-wave1.md', await fixture('package-wave1.md'), kit)
const wave2 = parsePackage('04-wave2.md', await fixture('package-wave2.md'), kit)

const channels = (file: { readonly entries: readonly PackageEntry[] }) =>
  file.entries.reduce<Record<string, number>>((counts, e) => ({ ...counts, [e.channel]: (counts[e.channel] ?? 0) + 1 }), {})

test('emails: Subject, and the body is the blockquote right after the bullets', () => {
  const first = entry(wave1.entries, 1)
  assert.equal(first.letter?.subject, 'Part-time junior engineer (Node/AWS/AI), Jan–Jun 2027')
  assert.ok(first.letter?.body.startsWith('Hi Kookaburra team,\n\nYour careers FAQ'))
  assert.deepEqual(first.missing, [])
})

test('channel by the PRIMARY destination: one per shape of Send via', () => {
  const shapes: readonly (readonly [string, string])[] = [
    ['hr@acme.example', 'email'],
    ['email info@acme.example', 'email'],
    ['email to Careers — **[Careers email — TODO]**', 'email'],
    ['LinkedIn message to Kim Doe (first)', 'linkedin'],
    ['LinkedIn message to Kim Doe', 'linkedin'],
    ['LinkedIn to Kim Doe (https://www.linkedin.com/company/acme)', 'linkedin'],
    ['LinkedIn (https://linkedin.com/company/acme)', 'linkedin'],
    ['SEEK — https://www.seek.com.au/job/1', 'platform'],
    ['BambooHR — https://acme.bamboohr.com/careers/1', 'form'],
    ['https://acme.example/contact-us (contact form, Sydney office)', 'form'],
    ['the contact option on https://acme.example', 'form'],
    ['https://acme.example/careers (register interest; no email in the data)', 'form'],
    ['Expression of Interest at https://jobs.dover.com/acme', 'form'],
    ['the Sales contact at https://acme.example/partner (or phone 1300 000 000)', 'form'],
  ]
  for (const [primary, expected] of shapes) assert.equal(channelOf(primary).channel, expected, primary)
})

test('Send via splits outside parentheses by · ; plus then or otherwise and (cc', () => {
  assert.deepEqual(splitSendVia('LinkedIn message to A (first) · email a@x.example'), ['LinkedIn message to A (first)', 'email a@x.example'])
  assert.deepEqual(splitSendVia('LinkedIn to A (https://x; y), then email a@x.example'), ['LinkedIn to A (https://x; y)', 'email a@x.example'])
  assert.deepEqual(splitSendVia('a@x.example, plus LinkedIn to B'), ['a@x.example', 'LinkedIn to B'])
  assert.deepEqual(splitSendVia('LinkedIn to A; b@x.example only as a fallback'), ['LinkedIn to A', 'b@x.example only as a fallback'])
  assert.deepEqual(splitSendVia('LinkedIn message to A; otherwise the contact option on https://x'), ['LinkedIn message to A', 'the contact option on https://x'])
  assert.deepEqual(splitSendVia('a@x.example, or the postings via https://x'), ['a@x.example', 'the postings via https://x'])
  assert.deepEqual(splitSendVia('Dover — https://x (cc c@x.example optional)'), ['Dover — https://x', 'cc c@x.example optional'])
  assert.deepEqual(splitSendVia('form — https://x **and** email h@x.example'), ['form — https://x', 'email h@x.example'])
  assert.deepEqual(splitSendVia('LinkedIn to A (https://x), cc p@x.example (seen)'), ['LinkedIn to A (https://x)', 'cc p@x.example (seen)'])
})

test('LinkedIn first, then an email → linkedin, the instruction without linkedin.com URLs, the email a secondary contact', () => {
  const lyrebird = entry(wave1.entries, 2)
  assert.equal(lyrebird.channel, 'linkedin')
  assert.deepEqual(lyrebird.target, { to: null, url: null, instruction: 'LinkedIn message to Robin Vale (first)' })
  assert.deepEqual(lyrebird.addresses, [{ email: 'info@lyrebird.example', status: 'unverified', evidence: null, primary: false }])
  const possum = entry(wave2.entries, 1)
  assert.equal(possum.channel, 'linkedin')
  assert.equal(possum.target.instruction, 'LinkedIn message to Jo Park')
  assert.deepEqual(possum.addresses.map((a) => a.email), ['business@possum.example'])
  const quokka = entry(wave1.entries, 4)
  assert.deepEqual(quokka.target, { to: null, url: null, instruction: 'LinkedIn' })
})

test('a form or a careers page first → form, even with LinkedIn after it', () => {
  const numbat = entry(wave1.entries, 3)
  assert.equal(numbat.channel, 'form')
  assert.equal(numbat.target.url, 'https://numbat.example/contact-us/')
  assert.equal(entry(wave1.entries, 5).target.url, 'https://wombat.example')
  assert.equal(entry(wave2.entries, 8).channel, 'form')
  assert.equal(entry(wave2.entries, 8).target.url, 'https://cassowary.bamboohr.com/careers')
})

test('email only when the first destination is an address; secondary addresses are contacts', () => {
  const echidna = entry(wave1.entries, 6)
  assert.equal(echidna.channel, 'email')
  assert.equal(echidna.target.to, 'info@echidna.example')
  assert.deepEqual(echidna.addresses, [{ email: 'info@echidna.example', status: 'unverified', evidence: null, primary: true }])
  assert.deepEqual(entry(ads.entries, 5).addresses.map((a) => [a.email, a.primary]), [['hr@petrel.example', false]])
  assert.deepEqual(entry(ads.entries, 7).addresses.map((a) => [a.email, a.primary]), [['careers@ironbark.example', false]])
  assert.deepEqual(entry(ads.entries, 6).addresses, [])
})

test('channel counts per file', () => {
  assert.deepEqual(channels(ads), { platform: 1, form: 5, email: 1 })
  assert.deepEqual(channels(wave1), { email: 2, linkedin: 2, form: 2 })
  assert.deepEqual(channels(wave2), { linkedin: 3, email: 4, form: 2 })
})

test('every address enters unverified, with or without the «Unverified address» mark', () => {
  assert.equal(entry(wave1.entries, 1).addresses[0]?.status, 'unverified') // marked in the notes
  assert.equal(entry(wave2.entries, 2).addresses[0]?.status, 'unverified') // not marked at all
  assert.equal(entry(wave2.entries, 3).addresses[0]?.status, 'unverified') // marked in Send via
})

test('an address the package says was seen on the site, with a date, enters verified, with the line as evidence', () => {
  const verified = (n: number) => entry(wave2.entries, n).addresses.filter((a) => a.status === 'verified')
  assert.deepEqual(verified(4).map((a) => a.email), ['hello@emu.example']) // seen on the homepage on 10 Nov 2026
  assert.deepEqual(verified(5).map((a) => a.email), ['info@bilby.example']) // seen on the site 10 Nov 2026
  assert.deepEqual(verified(6).map((a) => a.email), ['contact@quoll.example']) // (seen 10 Nov 2026, …)
  assert.deepEqual(verified(7).map((a) => a.email), ['hello@cockatoo.example']) // seen on the homepage, 10 Nov 2026
  assert.deepEqual(verified(8).map((a) => a.email), ['hello@cassowary.example']) // seen on the contact page, 10 Nov 2026
  assert.match(verified(4)[0]?.evidence ?? '', /seen on the homepage on 10 Nov 2026/)
})

test('«seen on the homepage» without a date, and «only seen on an aggregator», are not verified', () => {
  assert.deepEqual(entry(wave2.entries, 9).addresses.map((a) => a.status), ['unverified'])
  assert.equal(seenOnSite('support@x.example (seen on the homepage) only as a fallback'), false)
  assert.equal(seenOnSite('the listing was only seen on an aggregator: https://jobs.example/2026-10-x'), false)
  assert.equal(seenOnSite('hello@x.example (from Exa data, but seen on the homepage on 10 Nov 2026)'), true)
  assert.equal(seenOnSite('hello@x.example (seen 2026-11-10 on the site)'), true)
  assert.equal(seenOnSite('seen in LinkedIn data 10 Nov 2026'), false)
  assert.equal(seenOnSite('seen (somewhere) 10 Nov 2026'), false)
})

test('wave 1: the signature line becomes the {signature} slot', () => {
  const body = entry(wave1.entries, 1).letter?.body ?? ''
  assert.ok(body.endsWith('Could we have a 15-minute call?\n\n{signature}'))
  assert.ok(entry(ads.entries, 6).letter?.body.endsWith('Thank you,\n{signature}'))
})

test('wave 2: the signature at the top of the file → {signature} appended to every body', () => {
  for (const e of wave2.entries) assert.ok(e.letter?.body.endsWith('\n\n{signature}'), `${e.n}`)
  assert.ok(entry(wave2.entries, 1).letter?.body.endsWith('Would a 20-minute chat in the week of 19 January suit?\n\n{signature}'))
  assert.ok(!entry(ads.entries, 3).letter?.body.includes('{signature}'), 'no top signature in the ads file: nothing appended')
})

test('no stored text carries the phone or the signature of the fixture profile', () => {
  for (const file of [ads, wave1, wave2]) {
    for (const e of file.entries) {
      const texts = [e.letter?.subject, e.letter?.body, e.linkedin, e.notes, ...e.form.flatMap((f) => [f.answer, f.hint])]
      for (const text of texts.filter((t): t is string => typeof t === 'string')) {
        assert.ok(!text.includes('+61 400 000 000'), `${file.file}#${e.n}: ${text}`)
        assert.ok(!text.includes('[phone]'), `${file.file}#${e.n}: ${text}`)
        assert.ok(!text.includes('alex.example@example.com'), `${file.file}#${e.n}: ${text}`)
      }
    }
  }
})

test('the LinkedIn note inline (wave 2) or in a blockquote after «— to X:» (wave 1)', () => {
  assert.equal(entry(wave2.entries, 1).linkedin, 'Hi Jo — I own the tool-calling layer of a production agent. Open to a part-time engineer on your agents?')
  assert.equal(entry(wave1.entries, 1).linkedin, 'Hi Dana, I build production LLM agents and would like to offer part-time engineering. Open to a 15-min chat?')
})

test('other placeholders stay in the body for the linter to block', () => {
  assert.ok(entry(wave2.entries, 2).letter?.body.includes('[Why climate: one honest sentence in your own words. TODO]'))
})

// ── S6b: «Sent by hand» (the fallback line) ───────────────────────────────────────────────────────

test('«**Sent by hand:** YYYY-MM-DD» is read in the three shapes, as a bullet or as a line of its own', async () => {
  const marked = (markdown: string, after: string, line: string): string => {
    assert.ok(markdown.includes(after), after)
    return markdown.replace(after, `${after}\n${line}`)
  }
  const adsMarked = parsePackage('02.md', marked(await fixture('package-ads.md'), '- **Ad status (2026-11-10):** live, posted 20 days ago. Apply today.', '- **Sent by hand:** 2026-11-12'), kit)
  const wave1Marked = parsePackage('03.md', marked(await fixture('package-wave1.md'), '> Could we have a 15-minute call?\n>\n> Alex Example · alex.example@example.com · [phone] · linkedin.com/in/alex-example\n', '**Sent by hand:** 2026-11-11'), kit)
  const wave2Marked = parsePackage('04.md', marked(await fixture('package-wave2.md'), '- **Send via:** careers@galah.example · **Contact:** none verified', '- **Sent by hand:** 2026-1-3'), kit)
  assert.equal(entry(adsMarked.entries, 1).sentByHand, '2026-11-12')
  assert.equal(entry(wave1Marked.entries, 1).sentByHand, '2026-11-11')
  assert.equal(entry(wave2Marked.entries, 2).sentByHand, '2026-1-3', 'read as written; the import validates it')
  assert.equal(entry(adsMarked.entries, 2).sentByHand, null)
  assert.equal(entry(wave2Marked.entries, 2).target.to, 'careers@galah.example', 'the bullet does not disturb the other fields')
  assert.ok([...ads.entries, ...wave1.entries, ...wave2.entries].every((e) => e.sentByHand === null))
})

// ── Review fix: a `---` inside an entry does not end it ────────────────────────────────────────────

test('a --- inside an entry does not cut it: a Sent by hand mark and the notes after it are kept', () => {
  const markdown = [
    '## 1. Kestrel Freight',
    '',
    '- **Send via:** hr@kestrel.example · **Contact:** none',
    '- **Role:** Analyst · **CV version:** A',
    '- **Subject:** Hello',
    '',
    '> Hi.',
    '',
    '---',
    '',
    '**Sent by hand:** 2026-11-10',
    '',
    '**Owner notes**',
    '- after the rule',
    '',
    '---',
    '',
    '## 2. Bluegum Analytics',
    '',
    '- **Send via:** hi@bluegum.example',
    '',
    '**Owner notes**',
    '- the last one',
    '',
    '---',
    '',
  ].join('\n')
  const parsed = parsePackage('x.md', markdown, kit)
  const first = entry(parsed.entries, 1)
  assert.equal(first.sentByHand, '2026-11-10')
  assert.equal(first.notes, '- after the rule')
  assert.equal(first.letter?.body, 'Hi.')
  assert.equal(entry(parsed.entries, 2).notes, '- the last one')
})

// ── Review fix: form lines that do not parse, and questions without an answer, are issues ──────────

test('a form line that does not parse and a question with no answer are issues of the entry', () => {
  const markdown = [
    '## 1. Kestrel Freight',
    '',
    '- **Send via:** https://kestrel.example/apply',
    '',
    '**Likely form questions**',
    '',
    '- *Why us?* — Because.',
    '- Plain question without italics — an answer',
    '- *Anything else?*',
    '- *Blank after the dash?* — ',
    '',
  ].join('\n')
  const parsed = entry(parsePackage('x.md', markdown, kit).entries, 1)
  assert.deepEqual(
    parsed.form.map((f) => f.question),
    ['Why us?', 'Anything else?', 'Blank after the dash?'],
  )
  assert.deepEqual(parsed.issues, [
    { kind: 'unparsed-form-line', detail: '- Plain question without italics — an answer' },
    { kind: 'empty-answer', detail: 'Anything else?' },
    { kind: 'empty-answer', detail: 'Blank after the dash?' },
  ])
  assert.deepEqual(entry(ads.entries, 1).issues, [])
})
