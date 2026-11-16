/**
 * Whether a reply's `From` is the sender's own (design D12 «Remitente verificado para las reglas 2 y
 * 3»). PURE. `From` can be forged; a reply matched only by its domain or an ATS (rules 2–3) moves an
 * application only when Gmail vouched for it. Rule 1 (our own `Message-ID` in the thread) needs none.
 *
 * WHAT COUNTS: the FIRST `Authentication-Results` header of the mail — the one Gmail prepends on
 * receipt; any other may have come with the mail itself, written by whoever forged it — when its
 * authserv-id is `mx.google.com`, and in it:
 * - `dmarc=pass`, with `header.from` (when given) the From's domain: DMARC already aligned the From
 *   with SPF or DKIM, against the real Public Suffix List; or
 * - `dkim=pass` whose signing domain (`header.d`, or the domain of `header.i`, which is what Gmail
 *   writes) is the From's domain, or a parent or a subdomain of it (`mg.acme.com` signing for
 *   `acme.com`). NOT a sibling: without the Public Suffix List, «the same registrable domain» cannot
 *   tell `acme.github.io` from `evil.github.io`, so a sibling (`news.acme.com` for `jobs.acme.com`)
 *   fails closed — its DMARC still verifies it. No one can sign as a public suffix itself.
 * Anything else — no header, another server's, `fail`, `none`, a signature of another domain — is NOT
 * verified.
 *
 * THE HEADER IS PARSED AS RFC 8601 SAYS, never by a bare split: comments (nested, with quoted pairs)
 * are dropped and quoted strings are emptied BEFORE splitting on `;`, because Gmail copies values the
 * sender chose (`smtp.mailfrom` may carry a quoted local part with `; dmarc=pass` inside it). Only
 * plain tokens are read as a method, a result or a property.
 */

/** Gmail's authserv-id: the only one trusted. */
export const GMAIL_AUTHSERV_ID = 'mx.google.com'

const TOKEN = /^[a-z0-9][a-z0-9._-]*$/

/** The header value with every comment dropped and every quoted string emptied (`""`), lower case. */
export function stripQuotesAndComments(value: string): string {
  let out = ''
  let depth = 0
  let quoted = false
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i]
    if (ch === '\\' && (quoted || depth > 0)) {
      i += 1 // a quoted pair: the next character is taken literally, and dropped with its string
      continue
    }
    if (quoted) {
      if (ch === '"') {
        quoted = false
        out += '"'
      }
      continue
    }
    if (ch === '(') {
      depth += 1
      continue
    }
    if (ch === ')' && depth > 0) {
      depth -= 1
      continue
    }
    if (depth > 0) continue
    if (ch === '"') quoted = true
    out += ch
  }
  return out.toLowerCase()
}

interface Method {
  readonly name: string
  readonly result: string
  readonly props: ReadonlyMap<string, string>
}

/** `method=result prop=value …` of one resinfo, plain tokens only; undefined when it is not one. */
function methodOf(resinfo: string): Method | undefined {
  const [head, ...rest] = resinfo.trim().split(/\s+/)
  const [name, result, extra] = (head ?? '').split('=')
  if (name === undefined || result === undefined || extra !== undefined || !TOKEN.test(name) || !TOKEN.test(result)) return undefined
  const props = new Map<string, string>()
  for (const token of rest) {
    const [key, value, more] = token.split('=')
    if (key !== undefined && value !== undefined && more === undefined && TOKEN.test(key)) props.set(key, value)
  }
  return { name, result, props }
}

/** Every method of one header value whose authserv-id is Gmail's; [] for any other server. */
function gmailMethods(value: string): readonly Method[] {
  const [authserv, ...resinfos] = stripQuotesAndComments(value).split(';')
  if (authserv?.trim().split(/\s+/)[0] !== GMAIL_AUTHSERV_ID) return []
  return resinfos.flatMap((resinfo) => methodOf(resinfo) ?? [])
}

const clean = (domain: string): string => domain.trim().toLowerCase().replace(/\.$/, '')
const within = (child: string, parent: string): boolean => child === parent || child.endsWith(`.${parent}`)

/** The From's address was vouched for by Gmail (see the header of this file). */
export function senderVerified(authenticationResults: readonly string[], fromAddress: string): boolean {
  const at = fromAddress.lastIndexOf('@')
  const first = authenticationResults[0]
  if (at === -1 || first === undefined) return false
  const from = clean(fromAddress.slice(at + 1))
  if (!TOKEN.test(from) || !from.includes('.')) return false
  return gmailMethods(first).some((method) => {
    if (method.result !== 'pass') return false
    if (method.name === 'dmarc') {
      const headerFrom = method.props.get('header.from')
      return headerFrom === undefined || clean(headerFrom) === from
    }
    if (method.name !== 'dkim') return false
    const identity = method.props.get('header.i')
    const signer = clean(method.props.get('header.d') ?? identity?.slice(identity.lastIndexOf('@') + 1) ?? '')
    return TOKEN.test(signer) && signer.includes('.') && (within(from, signer) || within(signer, from))
  })
}
