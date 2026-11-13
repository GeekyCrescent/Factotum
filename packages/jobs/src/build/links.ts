/**
 * The «external link» rule of the linter (design D6, addition of 13-nov; G9). PURE.
 *
 * An ad is untrusted text that Claude reads: it can ask for a link or an address to be written into
 * the letter, a form answer or the CV («send your CV to hr@elsewhere…», «include https://…»). So
 * every URL (`http://`, `https://`), `www.` host or email address in a text that is sent must be
 * ONE OF OURS or THE COMPANY'S:
 *
 * - the profile's own email, LinkedIn and portfolio (a page under the portfolio or the LinkedIn
 *   profile passes; `github.com/someone-else` does not when the portfolio is `github.com/alex`);
 * - the company's domain and its website's host, with their subdomains; a page under its careers
 *   URL (an ATS host is shared, so only that board, not the whole host);
 * - the address the application is sent to, and the company's contacts' addresses, exactly.
 *
 * Anything else is a block the owner can clear with «I checked it», like `unsupported-claim`.
 * A bare domain with no scheme and no `www.` is not looked at: it cannot be clicked in most clients
 * and catching it would block every company name that ends in `.io`.
 */

import type { Company, Contact, Profile } from '../types.ts'

export interface LinkOwners {
  readonly profile: Profile
  readonly company: Pick<Company, 'domain' | 'website' | 'careersUrl'> & { readonly contacts: readonly Pick<Contact, 'email'>[] }
  /** `target.to`, when there is one. */
  readonly to: string | null
}

/**
 * A URL, a `www.` host, or an email address. Each alternative only STARTS at a boundary (the
 * lookbehinds), so a long run of word characters is scanned once, not once per position.
 */
const LINK =
  /https?:\/\/[^\s<>"'()[\]{}]+|(?<![\w.@-])www\.[^\s<>"'()[\]{}]+|(?<![\w.%+-])[\w.%+-]+@[a-z0-9.-]+\.[a-z]{2,}(?![\w-])/gi

/** The sentence's punctuation after a link is not part of it. */
const TRAILING = /[.,;:!?]+$/
const SCHEME = /^https?:\/\//
const PATH_START = /[/?#]/

/** The links of `text`, as written, in order. */
export function linksIn(text: string): readonly string[] {
  return [...text.matchAll(LINK)].map((m) => m[0].replace(TRAILING, '')).filter((link) => link !== '')
}

const isEmail = (link: string): boolean => !SCHEME.test(link.toLowerCase()) && !link.toLowerCase().startsWith('www.') && link.includes('@')

/** `https://www.Example.com/a/` → `example.com/a`: no scheme, no `www.`, no user, no port, no final slash. */
function normalUrl(url: string): string {
  const bare = url.trim().toLowerCase().replace(SCHEME, '')
  const cut = bare.search(PATH_START)
  const authority = cut === -1 ? bare : bare.slice(0, cut)
  const rest = cut === -1 ? '' : bare.slice(cut)
  const host = (authority.split('@').pop() ?? '').replace(/:\d+$/, '').replace(/^www\./, '')
  return `${host}${rest}`.replace(/\/+$/, '')
}

const hostOf = (normal: string): string => normal.split(PATH_START)[0] ?? ''

const isUnderHost = (host: string, owner: string): boolean => host === owner || host.endsWith(`.${owner}`)

/** `prefix` itself, or a page under it — never `prefix-other`. */
const isUnderPrefix = (normal: string, prefix: string): boolean =>
  normal === prefix || (normal.startsWith(prefix) && PATH_START.test(normal.charAt(prefix.length)))

const present = (values: readonly (string | null)[]): readonly string[] => values.filter((v): v is string => v !== null && v.trim() !== '')

/** True when `link` is the profile's own or the company's (see the header). */
export function isOwnLink(link: string, owners: LinkOwners): boolean {
  const { profile, company } = owners
  const hosts = present([company.domain, company.website].map((url) => (url === null ? null : hostOf(normalUrl(url)))))
  if (isEmail(link)) {
    const address = link.toLowerCase()
    const addresses = present([profile.identity.email, owners.to, ...company.contacts.map((c) => c.email)]).map((a) => a.trim().toLowerCase())
    const domain = address.slice(address.lastIndexOf('@') + 1)
    return addresses.includes(address) || hosts.some((host) => isUnderHost(domain, host))
  }
  const normal = normalUrl(link)
  const prefixes = present([profile.identity.linkedin, profile.identity.portfolioUrl, company.careersUrl].map((url) => (url === null ? null : normalUrl(url))))
  return hosts.some((host) => isUnderHost(hostOf(normal), host)) || prefixes.some((prefix) => isUnderPrefix(normal, prefix))
}

/** The links of `text` that are neither ours nor the company's, in order, once each. */
export function externalLinks(text: string, owners: LinkOwners): readonly string[] {
  return [...new Set(linksIn(text))].filter((link) => !isOwnLink(link, owners))
}
