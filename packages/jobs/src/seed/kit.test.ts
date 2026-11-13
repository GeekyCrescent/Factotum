import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

import { fillSlots } from '../build/slots.ts'
import { loadProfileSeed } from '../profile.ts'
import type { Profile } from '../types.ts'
import { parseCvs, parseKit, resolveFormAnswer, resolveKitRef, seedFollowupTemplates } from './kit.ts'

const fixture = (name: string) => readFile(new URL(`../../test/fixtures/${name}`, import.meta.url), 'utf8')
const KIT_MD = await fixture('kit.md')
const kit = parseKit(KIT_MD)

const BRACKET = /\[[^\]\n]{1,80}\]/

/** A test profile with the three fields the kit's slots need (design D6 «Huecos»). */
const PROFILE: Profile = (() => {
  const seeded = loadProfileSeed()
  if (!seeded.ok) throw new Error(seeded.error.reason)
  const { identity, preferences } = seeded.value
  return {
    ...seeded.value,
    identity: { ...identity, suburb: 'Ryde', timezone: 'UTC+11 / Sydney' },
    preferences: { ...preferences, rateExpectation: 'A$40 per hour' },
  }
})()

test('a section splits into questions: a bold line is the label, the blockquote after it the answer', () => {
  assert.deepEqual(kit.sections.get(2), [
    {
      label: 'Do you have the right to work in Australia?',
      answer: 'Yes. I hold a temporary visa with work rights, valid to the end of 2027. I can provide a confirmation on request.',
    },
    { label: 'Do you require sponsorship?', answer: 'No — not for this engagement.' },
  ])
})

test('a cite to §2 gives only the right-to-work answer: no callout, no checkbox, no dropdown paragraph', () => {
  const match = resolveKitRef('Right to work in Australia?', { section: 2, phrase: '' }, kit)
  assert.ok(match)
  assert.equal(match.label, 'Do you have the right to work in Australia?')
  assert.equal(match.ambiguous, false)
  assert.ok(!match.answer.includes('[!todo]'))
  assert.ok(!match.answer.includes('- [ ]'))
  assert.ok(!match.answer.includes('dropdown'))
  assert.ok(!BRACKET.test(match.answer))
})

test('"Notice required…" matches "Notice period" in §6', () => {
  const match = resolveKitRef('Notice required for your current employer?', { section: 6, phrase: '' }, kit)
  assert.equal(match?.label, 'Notice period')
  assert.equal(match?.answer, 'I can start on 12 January 2027.')
  assert.equal(match?.ambiguous, false)
})

test('the "see …" phrase counts as well as the question', () => {
  const match = resolveKitRef('Where are you based?', { section: 6, phrase: 'the location answer in' }, kit)
  assert.equal(match?.label, 'Location / commute')
})

test('a tie, or no word in common, takes the first question and says ambiguous', () => {
  const tied = parseKit('## 9. Tie\n\n**Alpha one**\n> first\n\n**Beta one**\n> second\n')
  assert.deepEqual(resolveKitRef('One?', { section: 9, phrase: '' }, tied), { section: 9, label: 'Alpha one', answer: 'first', ambiguous: true })
  assert.deepEqual(resolveKitRef('Nothing shared?', { section: 9, phrase: '' }, tied), { section: 9, label: 'Alpha one', answer: 'first', ambiguous: true })
})

test('a single-question section is its answer, not ambiguous; an unknown section is null', () => {
  const single = parseKit('## 4. One\n\n**Only**\n> the answer\n')
  assert.deepEqual(resolveKitRef('Anything?', { section: 4, phrase: '' }, single), { section: 4, label: 'Only', answer: 'the answer', ambiguous: false })
  assert.equal(resolveKitRef('Anything?', { section: 5, phrase: '' }, single), null)
})

test('the kit TODOs become slots: suburb, timezone and rate', () => {
  const six = kit.sections.get(6) ?? []
  assert.equal(six.find((q) => q.label === 'Location / commute')?.answer, 'I live in Sydney {suburb} and can commute to the office or work hybrid.')
  assert.ok(six.find((q) => q.label.startsWith('Availability for interviews'))?.answer.includes('be in {timezone}, so'))
  assert.equal(kit.sections.get(3)?.find((q) => q.label === 'If the form forces a number')?.answer, '{rate}')
})

test('a form answer that is only the cite becomes the kit answer, and the parenthesis behind goes to hint', () => {
  const resolved = resolveFormAnswer(
    'Notice required for your current employer?',
    'see [[00-kit-base]] §6 ("I can start on 12 January 2027" — confirm with your employer first).',
    kit,
  )
  assert.deepEqual(resolved, {
    answer: 'I can start on 12 January 2027.',
    hint: '"I can start on 12 January 2027" — confirm with your employer first',
    ref: { section: 6, matched: 'Notice period', ambiguous: false },
  })
})

test('a cite followed by a semicolon sends the rest to hint', () => {
  const resolved = resolveFormAnswer('Right to work / background check consent?', 'see [[00-kit-base]] §2; consent to the background check.', kit)
  assert.equal(resolved.answer, kit.sections.get(2)?.[0]?.answer)
  assert.equal(resolved.hint, 'consent to the background check')
})

test('a cite inside a written answer: the answer stays, only the cite fragment goes to hint', () => {
  const dashed = resolveFormAnswer(
    'Availability for a paid work trial?',
    'Yes, from 12 January 2027 (or by video before then — see [[00-kit-base]] §6 for December travel).',
    kit,
  )
  assert.deepEqual(dashed, {
    answer: 'Yes, from 12 January 2027 (or by video before then).',
    hint: 'see [[00-kit-base]] §6 for December travel',
    ref: null,
  })
  const parenthesised = resolveFormAnswer('Years of experience?', 'about 1 (see [[00-kit-base]] §6). Don\'t round up.', kit)
  assert.deepEqual(parenthesised, { answer: 'about 1. Don\'t round up.', hint: 'see [[00-kit-base]] §6', ref: null })
  const toSentenceEnd = resolveFormAnswer('Experience?', 'About a year — see [[00-kit-base]] §6. Ask me more.', kit)
  assert.deepEqual(toSentenceEnd, { answer: 'About a year. Ask me more.', hint: 'see [[00-kit-base]] §6', ref: null })
})

test('a written answer without a cite is left as it is; a cite to a missing section stays, flagged in hint', () => {
  assert.deepEqual(resolveFormAnswer('Why?', 'Because.', kit), { answer: 'Because.', hint: null, ref: null })
  const missing = resolveFormAnswer('Bio?', 'see [[00-kit-base]] §5.', kit)
  assert.equal(missing.answer, 'see [[00-kit-base]] §5.')
  assert.deepEqual(missing.ref, { section: 5, matched: null, ambiguous: false })
  assert.match(missing.hint ?? '', /§5/)
})

test('after filling suburb, timezone and rate, no resolved answer carries a [...]', () => {
  const questions = [
    ['Right to work in Australia?', 'see [[00-kit-base]] §2.'],
    ['Notice required?', 'see [[00-kit-base]] §6 (confirm first).'],
    ['Where are you based?', 'see the location answer in [[00-kit-base]] §6.'],
    ['Interview availability?', 'see [[00-kit-base]] §6.'],
    ['Hourly rate, if the form forces a number?', 'see [[00-kit-base]] §3.'],
    ['Hours / availability?', 'see [[00-kit-base]] §1.'],
  ] as const
  for (const [question, answer] of questions) {
    const { text: filled, missing } = fillSlots(resolveFormAnswer(question, answer, kit).answer, PROFILE)
    assert.deepEqual(missing, [], question)
    assert.ok(!BRACKET.test(filled), `${question} → ${filled}`)
    assert.ok(!/\{[a-z]+\}/i.test(filled), `${question} → ${filled}`)
  }
})

test('an answer that keeps a [...] after translation is reported, and still carried', () => {
  const odd = parseKit('## 6. Q\n\n**Visa**\n> I hold [visa name — TODO].\n')
  assert.equal(odd.sections.get(6)?.[0]?.answer, 'I hold [visa name — TODO].')
  assert.deepEqual(odd.leftovers, [{ section: 6, label: 'Visa', token: '[visa name — TODO]' }])
  assert.deepEqual(kit.leftovers, [])
})

test('the follow-up templates are seeded from §7 and §8 with the tokens translated', () => {
  const { templates, warnings } = seedFollowupTemplates(KIT_MD)
  assert.deepEqual(warnings, [])
  assert.ok(templates)
  assert.equal(templates.subject, 'Following up — {role} application, Alex Example')
  assert.equal(
    templates.first,
    [
      'Hi {greetingName},',
      '',
      "I applied for the {role} position on {sentDate} and wanted to follow up briefly. I'm still very interested in the {role} role at {company}.",
      '',
      "As a quick reminder: I'm a software engineer with about a year of commercial experience, available from 12 January 2027.",
      '',
      "If it helps, I'm happy to do a short call at a time that suits you.",
      '',
      'Kind regards,',
      '{signature}',
    ].join('\n'),
  )
  assert.ok(templates.second.includes("I'm following up once more on my application for the {role} position, sent on {sentDate}. I'm still very interested"))
  assert.ok(!templates.second.includes('I applied for'))
  assert.equal(
    templates.linkedin,
    "Hi {greetingName}, I applied for {role} at {company} last week. I build LLM agents on AWS and I'm available in Sydney from 12 Jan 2027. Happy to share more if useful. — Alex",
  )
})

test('the seeded templates carry no [...], no CV attachment line, no closing note and no profile data', () => {
  const { templates } = seedFollowupTemplates(KIT_MD)
  assert.ok(templates)
  for (const text of [templates.subject, templates.first, templates.second, templates.linkedin]) {
    assert.ok(!BRACKET.test(text), text)
    assert.ok(!text.includes('attached'), text)
    assert.ok(!text.includes('Send one follow-up only'), text)
    assert.ok(!text.includes('+61 400 000 000'), text)
    assert.ok(!text.includes('alex.example@example.com'), text)
  }
})

test('a kit with another [...] in §7 warns and seeds no template', () => {
  const odd = KIT_MD.replace('As a quick reminder:', 'As a quick reminder [your hook — TODO]:')
  const { templates, warnings } = seedFollowupTemplates(odd)
  assert.equal(templates, null)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0] ?? '', /§7.*\[your hook — TODO\]/)
})

test('a kit without §7 or §8 warns and seeds no template', () => {
  const { templates, warnings } = seedFollowupTemplates('## 1. Availability\n\n**Short**\n> yes\n')
  assert.equal(templates, null)
  assert.deepEqual(warnings, ['kit §7: no follow-up email found', 'kit §8: no LinkedIn note found'])
})

test('the base CVs A and B run from their heading to "Para el owner"', async () => {
  const cvs = parseCvs(await fixture('cvs.md'))
  assert.ok(cvs.A.startsWith('**Alex Example**'))
  assert.ok(cvs.A.includes('Software engineer building LLM agents on AWS.'))
  assert.ok(cvs.A.endsWith('- Built the tool-calling layer of a production agent.'))
  assert.ok(!cvs.A.includes('Para el owner'))
  assert.ok(!cvs.A.includes('CV B'))
  assert.ok(cvs.B.startsWith('**Alex Example**'))
  assert.ok(cvs.B.endsWith('- Built every screen of a Next.js application.'))
  assert.ok(!cvs.B.includes('Checklist'))
  assert.throws(() => parseCvs('# CV A — only\n\ntext\n'), /CV B/)
})

test('a label with no blockquote answer and a section number used twice are kit issues, not silent', () => {
  const parsed = parseKit(
    [
      '## 2. Work rights',
      '',
      '**Right to work?**',
      '',
      '> Yes.',
      '',
      '**Unanswered question?**',
      '',
      '> [!todo] fill this in',
      '',
      '**Also unanswered**',
      '',
      'Just advice, no quote.',
      '',
      '## 2. Work rights again',
      '',
      '**Visa?**',
      '> Student visa.',
    ].join('\n'),
  )
  assert.deepEqual(parsed.issues, [
    { kind: 'kit-label-without-answer', section: 2, detail: 'Unanswered question?' },
    { kind: 'kit-label-without-answer', section: 2, detail: 'Also unanswered' },
    { kind: 'kit-duplicate-section', section: 2, detail: 'Work rights again' },
  ])
  assert.deepEqual(parsed.sections.get(2)?.map((q) => q.label), ['Right to work?'], 'the first section of a number wins')
  assert.deepEqual(kit.issues, [])
})
