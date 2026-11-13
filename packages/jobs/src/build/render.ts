/**
 * The CV as HTML (design D5 step 5; tasks H2). PURE: a `CvDoc`, the profile and the font's bytes in,
 * a string and a hash out. Nothing here reads a file, the clock or the network.
 *
 * THE CONTACT IS THE PROFILE'S, AT PRINT TIME, NEVER CLAUDE'S. `cvContactOf` is exactly what the
 * template reads of the profile — name, email, phone, LinkedIn, city and the availability line (v4,
 * B9) — and `contactHash` is the sha256 of its canonical JSON: the artifact keeps it, and the linter's
 * `cv-stale` compares it with today's profile. The prose `availability` and `situation` go to the
 * prompts only: editing them restales nothing.
 *
 * SELF-CONTAINED: every text escaped; fixed A4 CSS; Geist inlined as a `data:` URI; no script, no
 * `file://`, no `http` — Chromium needs no permission to read anything else, and the PDF it prints is
 * the same on every machine. The same doc and the same contact give the same bytes (a reprint, D5).
 */

import { createHash } from 'node:crypto'

import type { CvDoc, Profile } from '../types.ts'

export interface CvContact {
  readonly name: string
  readonly email: string
  readonly phone: string
  readonly linkedin: string
  readonly city: string
  readonly cvAvailabilityLine: string
}

export interface RenderedCv {
  readonly html: string
  readonly contactHash: string
}

const SEPARATOR = ' · '

/** What the template reads of the profile, in a fixed key order: that order IS the canonical JSON. */
export function cvContactOf(profile: Profile): CvContact {
  const { name, email, phone, linkedin, city, cvAvailabilityLine } = profile.identity
  return {
    name: name.trim(),
    email: email.trim(),
    phone: phone.trim(),
    linkedin: linkedin.trim(),
    city: city.trim(),
    cvAvailabilityLine: cvAvailabilityLine.trim(),
  }
}

/** sha256 of `cvContactOf(profile)`; what `cv-stale` compares (D6). */
export function contactHashOf(profile: Profile): string {
  return createHash('sha256').update(JSON.stringify(cvContactOf(profile))).digest('hex')
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

/** The LinkedIn as printed text, without its scheme: the HTML carries no link and no `http`. */
const bareUrl = (url: string): string => url.replace(/^https?:\/\//i, '').replace(/^www\./i, '')

const joined = (parts: readonly string[]): string => parts.filter((part) => part !== '').map(escapeHtml).join(SEPARATOR)

const CSS = `@page { size: A4; margin: 12mm }
* { box-sizing: border-box; margin: 0; padding: 0 }
body { font-family: 'Geist', sans-serif; font-size: 10pt; line-height: 1.32; color: #111 }
h1 { font-size: 18pt; font-weight: 650; letter-spacing: -0.01em }
h2 { font-size: 10.5pt; font-weight: 650; text-transform: uppercase; letter-spacing: 0.06em; border-bottom: 0.6pt solid #999; margin: 9pt 0 4pt; padding-bottom: 1.5pt }
.contact, .availability { color: #333; margin-top: 2pt }
.headline { font-weight: 600; margin-top: 6pt }
.summary { margin-top: 3pt }
.role { margin-top: 5pt; break-inside: avoid }
.role-head { display: flex; justify-content: space-between; gap: 8pt }
.org { font-weight: 600 }
.dates, .place { color: #444; white-space: nowrap }
.line { font-style: italic; color: #333 }
ul { margin: 2pt 0 0 12pt }
li { margin-top: 1.5pt }
.project { margin-top: 3pt }
.project-name { font-weight: 600 }
.skills p { margin-top: 1.5pt }
.label { font-weight: 600 }`

function fontFace(font: Uint8Array): string {
  const data = Buffer.from(font).toString('base64')
  return `@font-face { font-family: 'Geist'; src: url(data:font/woff2;base64,${data}) format('woff2'); font-weight: 100 900; font-style: normal }`
}

function header(doc: CvDoc, contact: CvContact): string {
  const lines = [
    `<h1>${escapeHtml(contact.name)}</h1>`,
    `<p class="contact">${joined([contact.city, contact.email, contact.phone, bareUrl(contact.linkedin)])}</p>`,
    contact.cvAvailabilityLine === '' ? '' : `<p class="availability">${escapeHtml(contact.cvAvailabilityLine)}</p>`,
    `<p class="headline">${escapeHtml(doc.headline)}</p>`,
    `<p class="summary">${escapeHtml(doc.summary)}</p>`,
  ]
  return lines.filter((line) => line !== '').join('\n')
}

const section = (title: string, body: readonly string[]): string => (body.length === 0 ? '' : `<section>\n<h2>${title}</h2>\n${body.join('\n')}\n</section>`)

function experienceOf(doc: CvDoc): string {
  return section(
    'Experience',
    doc.experience.map((role) => {
      const place = role.place === null ? '' : `<span class="place">${escapeHtml(role.place)}</span>`
      const right = `<span class="dates">${escapeHtml(role.dates)}</span>${place === '' ? '' : `${SEPARATOR}${place}`}`
      const line = role.line === null ? '' : `\n<p class="line">${escapeHtml(role.line)}</p>`
      const bullets = role.bullets.length === 0 ? '' : `\n<ul>${role.bullets.map((b) => `<li>${escapeHtml(b.text)}</li>`).join('')}</ul>`
      const head = `<div class="role-head"><span><span class="org">${escapeHtml(role.org)}</span>${SEPARATOR}${escapeHtml(role.title)}</span><span>${right}</span></div>`
      return `<div class="role">${head}${line}${bullets}</div>`
    }),
  )
}

function projectsOf(doc: CvDoc): string {
  return section(
    'Projects',
    doc.projects.map(
      (p) => `<p class="project"><span class="project-name">${escapeHtml(p.name)}</span>${SEPARATOR}${joined([p.role, p.status])}. ${escapeHtml(p.text)}</p>`,
    ),
  )
}

function restOf(doc: CvDoc): readonly string[] {
  return [
    section('Education', doc.education.map((e) => `<p>${escapeHtml(e.text)}</p>`)),
    section('Certifications', doc.certifications.length === 0 ? [] : [`<p>${joined(doc.certifications)}</p>`]),
    section(
      'Skills',
      doc.skills.length === 0 ? [] : [`<div class="skills">${doc.skills.map((s) => `<p><span class="label">${escapeHtml(s.label)}:</span> ${joined(s.items)}</p>`).join('')}</div>`],
    ),
  ]
}

/** `doc.gaps` are for the owner (`requirement-gap`) and are never printed. */
export function renderCvHtml(doc: CvDoc, profile: Profile, font: Uint8Array): RenderedCv {
  const contact = cvContactOf(profile)
  const body = [header(doc, contact), experienceOf(doc), projectsOf(doc), ...restOf(doc)].filter((part) => part !== '').join('\n')
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(contact.name)}</title>
<style>
${fontFace(font)}
${CSS}
</style>
</head>
<body>
${body}
</body>
</html>
`
  return { html, contactHash: contactHashOf(profile) }
}
