import { test } from 'node:test'
import assert from 'node:assert/strict'

import { DOC } from '../build/test-cv.ts'
import { CV_DOC_JSON_SCHEMA, cvDocSchema, MAX_GAPS, MAX_GAP_CHARS, MAX_SUMMARY_CHARS } from './schemas.ts'

const gap = (n: number) => ({ requirement: `Requirement ${n}`, why: 'No evidence in cv-maestro' })

test('a whole CvDoc passes and comes back equal', () => {
  const parsed = cvDocSchema.safeParse(DOC)
  assert.equal(parsed.success, true)
  assert.deepEqual(parsed.data, DOC)
})

test('gaps: up to five pass, a sixth is outside the schema (requirement-gap, v4 N2)', () => {
  const five = Array.from({ length: MAX_GAPS }, (_, i) => gap(i))
  assert.equal(cvDocSchema.safeParse({ ...DOC, gaps: five }).success, true)
  assert.equal(cvDocSchema.safeParse({ ...DOC, gaps: [...five, gap(6)] }).success, false)
})

test('a gap text over 160 characters is outside the schema', () => {
  const long = 'x'.repeat(MAX_GAP_CHARS + 1)
  assert.equal(cvDocSchema.safeParse({ ...DOC, gaps: [{ requirement: long, why: 'w' }] }).success, false)
  assert.equal(cvDocSchema.safeParse({ ...DOC, gaps: [{ requirement: 'r', why: long }] }).success, false)
})

test('the summary is at most 600 characters', () => {
  assert.equal(cvDocSchema.safeParse({ ...DOC, summary: 's'.repeat(MAX_SUMMARY_CHARS) }).success, true)
  assert.equal(cvDocSchema.safeParse({ ...DOC, summary: 's'.repeat(MAX_SUMMARY_CHARS + 1) }).success, false)
})

test('a bullet without its source, or an empty headline, is outside the schema', () => {
  const [first] = DOC.experience
  const noSource = { ...DOC, experience: [{ ...first, bullets: [{ text: 'Built it' }] }] }
  assert.equal(cvDocSchema.safeParse(noSource).success, false)
  assert.equal(cvDocSchema.safeParse({ ...DOC, headline: '' }).success, false)
})

test('the JSON Schema for --json-schema is draft-07 and carries the gaps limit', () => {
  const schema = JSON.parse(CV_DOC_JSON_SCHEMA) as {
    $schema: string
    required: string[]
    properties: { gaps: { maxItems: number }; summary: { maxLength: number } }
  }
  assert.equal(schema.$schema, 'http://json-schema.org/draft-07/schema#')
  assert.deepEqual(schema.required.sort(), ['certifications', 'education', 'experience', 'gaps', 'headline', 'projects', 'skills', 'summary'])
  assert.equal(schema.properties.gaps.maxItems, MAX_GAPS)
  assert.equal(schema.properties.summary.maxLength, MAX_SUMMARY_CHARS)
})
