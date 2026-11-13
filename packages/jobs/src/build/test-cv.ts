/**
 * Test-only fixtures of the CV builder and the linter (tasks H1–H4, L1, L2): a profile, a `CvDoc`,
 * artifacts, a company and an opportunity. ALL SYNTHETIC — a made-up person at a made-up firm; no
 * line here is copied from the owner's real `cv-maestro`, guide or profile.
 */

import type { Artifacts, Company, CvDoc, Opportunity, Profile } from '../types.ts'

export const PROFILE: Profile = {
  identity: {
    name: 'Alex Example',
    email: 'alex@example.test',
    phone: '+61 400 000 000',
    linkedin: 'linkedin.com/in/alex-example',
    city: 'Sydney',
    suburb: 'Newtown',
    timezone: 'Australia/Sydney',
    portfolioUrl: 'https://alex.example.test/',
    cvAvailabilityLine: 'Available from 4 Feb 2027 · 3 days a week',
  },
  situation: 'Studying in Sydney.',
  availability: 'From February 2027, three days a week.',
  absences: [],
  goals: [
    { id: 'part-time', label: 'Part-time in Sydney', enabled: true, text: 'Part-time engineering roles.', payFloor: null, sources: [] },
    { id: 'off', label: 'Switched off', enabled: false, text: 'Never shown.', payFloor: null, sources: [] },
  ],
  level: 'Junior.',
  redLines: { text: 'No unpaid work.', titleWords: ['senior', 'lead'], requirementWords: ['clearance'], unpaid: true, equityOnly: true },
  preferences: { text: 'Backend and cloud.', rateExpectation: '' },
  forbiddenStacks: ['Go', 'Kafka'],
  confidential: ['Acme Hospital', 'IMSS'],
  batchSize: 10,
  weights: { partTime: 30, skills: 25, hiring: 20, visa: 15, access: 10 },
  followup: { subject: 'Following up — {role}', first: 'Hi {greetingName}, {signature}', second: 'Hello again. {signature}', linkedin: 'Hi {greetingName}' },
}

export const DOC: CvDoc = {
  headline: 'Software Engineer — Cloud & Data',
  summary: 'Engineer who builds and ships backend services.',
  experience: [
    {
      org: 'Northwind Labs',
      title: 'Software Engineer',
      dates: 'Mar 2024 – Present',
      place: 'Remote',
      line: 'Promoted from intern in 12 months',
      bullets: [
        { text: 'Built a billing service used by 40 teams', source: '§5.1' },
        { text: 'Cut report time from 9 to 2 minutes', source: '§5.2' },
      ],
    },
  ],
  projects: [{ name: 'Pathfinder', role: 'Author', status: 'In production', text: 'A routing tool for field crews.', source: '§6.1' }],
  education: [{ text: 'Master of IT, Example University, 2026' }],
  certifications: ['Cloud Associate', 'Data Practitioner'],
  skills: [
    { label: 'Languages', items: ['TypeScript', 'Python'] },
    { label: 'Cloud', items: ['AWS', 'GCP'] },
  ],
  gaps: [],
}

/** The master CV the number rule reads: every figure `DOC` prints is here. */
export const MASTER = `# Master CV
Billing service: 40 teams. Report time 9 → 2 minutes. Promoted in 12 months. 2024, 2026.
`

export const ARTIFACTS: Artifacts = {
  version: 1,
  cv: DOC,
  pdf: '/state/artifacts/a/v1/cv.pdf',
  png: '/state/artifacts/a/v1/preview.png',
  contactHash: null,
  letter: { subject: 'Application — Software Engineer', body: 'Dear team,\n\nI would like to apply.\n\n{signature}' },
  form: [],
  skills: null,
  linkedin: null,
  profileVersion: 1,
  rules: [],
  usage: null,
  origin: 'generated',
}

export const COMPANY: Company & { readonly record: string } = {
  id: 'c1',
  name: 'Contoso',
  domain: 'contoso.test',
  website: 'https://contoso.test',
  careersUrl: null,
  linkedin: null,
  sector: 'Logistics software',
  size: null,
  location: 'Sydney',
  isHealthEmployer: false,
  healthSource: null,
  ats: null,
  contacts: [],
  record: '120 employees\nLogistics software',
}

export const OPPORTUNITY: Opportunity = {
  id: 'o1',
  companyId: 'c1',
  kind: 'vacancy',
  title: 'Graduate Software Engineer',
  goalId: null,
  url: 'https://contoso.test/jobs/1',
  postedAt: null,
  closesAt: null,
  startsAt: null,
  duration: null,
  hours: null,
  salary: null,
  requirements: 'TypeScript and AWS. 2 years of experience.',
  score: null,
  breakdown: null,
  profileVersion: 1,
  source: 'seed',
  sourceRef: null,
  remote: null,
  status: 'open',
  discardReason: null,
  checkedAt: null,
}
