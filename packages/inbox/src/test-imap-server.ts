/**
 * A MADE-UP IMAP SERVER, over TLS on loopback, for the one protocol test (spec 2026-10-05, D4; B7b;
 * criterion 6). Test-only, excluded from coverage.
 *
 * Its whole point is to stand in front of the REAL imapflow and write down every command it sends,
 * because what goes on the wire depends on what the server announces — so it announces EXACTLY the
 * CAPABILITY that Gmail returned in A1 (tasks §M), before and after the login, adding and removing
 * nothing. It answers just enough for one run over one mail.
 *
 * THE LINE AFTER `AUTHENTICATE` IS THE CREDENTIAL (a SASL continuation), not a command: it is never
 * recorded. Neither is an initial response on the AUTHENTICATE line itself, nor LOGIN's arguments.
 */

import { createServer, type Server, type TLSSocket } from 'node:tls'
import type { AddressInfo } from 'node:net'

/** Measured on imap.gmail.com, 2026-10-05 (tasks §M, A1). Do not edit by hand. */
export const GMAIL_CAPABILITY_BEFORE =
  'IMAP4rev1 UNSELECT IDLE NAMESPACE QUOTA ID XLIST CHILDREN X-GM-EXT-1 XYZZY SASL-IR AUTH=XOAUTH2 AUTH=PLAIN AUTH=PLAIN-CLIENTTOKEN AUTH=OAUTHBEARER'
export const GMAIL_CAPABILITY_AFTER =
  'IMAP4rev1 UNSELECT IDLE NAMESPACE QUOTA ID XLIST CHILDREN X-GM-EXT-1 UIDPLUS COMPRESS=DEFLATE ENABLE MOVE CONDSTORE ESEARCH UTF8=ACCEPT LIST-EXTENDED LIST-STATUS LITERAL- SPECIAL-USE APPENDLIMIT'

export interface ServedMail {
  readonly uid: number
  readonly internalDate: string
  readonly subject: string
  readonly fromName: string
  readonly fromAddress: string
  readonly toAddress: string
  readonly messageId: string
  readonly gmailId: string
  readonly headers: string
  readonly body: string
}

export interface FakeImapServer {
  readonly port: number
  /** Every command line, tag stripped, credentials never. */
  readonly commands: string[]
  readonly close: () => Promise<void>
}

export async function startFakeImap(tls: { key: string; cert: string }, mail: ServedMail): Promise<FakeImapServer> {
  const commands: string[] = []
  const sockets = new Set<TLSSocket>()
  const server: Server = createServer({ key: tls.key, cert: tls.cert }, (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => undefined)
    serve(socket, mail, commands)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    port,
    commands,
    close: async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

function serve(socket: TLSSocket, mail: ServedMail, commands: string[]): void {
  let buffer = Buffer.alloc(0)
  let line = ''
  let literal = 0
  let credentialNext: string | undefined
  let loggedIn = false

  const send = (text: string): void => void socket.write(`${text}\r\n`)
  send('* OK Gimap ready for requests from 127.0.0.1')

  socket.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk])
    for (;;) {
      if (literal > 0) {
        if (buffer.length < literal) return
        line += buffer.subarray(0, literal).toString('utf8')
        buffer = buffer.subarray(literal)
        literal = 0
        continue
      }
      const end = buffer.indexOf('\r\n')
      if (end === -1) return
      line += buffer.subarray(0, end).toString('utf8')
      buffer = buffer.subarray(end + 2)
      const announced = /\{(\d+)(\+?)\}$/.exec(line)
      if (announced !== null) {
        literal = Number(announced[1])
        if (announced[2] !== '+') send('+ go ahead')
        continue
      }
      const complete = line
      line = ''
      if (credentialNext !== undefined) {
        // The SASL continuation: the credential. Answered, never written down.
        const tag = credentialNext
        credentialNext = undefined
        loggedIn = true
        send(`${tag} OK [CAPABILITY ${GMAIL_CAPABILITY_AFTER}] user authenticated (Success)`)
        continue
      }
      handle(complete)
    }
  })

  function handle(raw: string): void {
    const space = raw.indexOf(' ')
    const tag = raw.slice(0, space)
    const rest = raw.slice(space + 1)
    const upper = rest.toUpperCase()
    const verb = upper.startsWith('UID ') ? upper.split(' ').slice(0, 2).join(' ') : (upper.split(' ')[0] ?? '')

    if (verb === 'AUTHENTICATE') {
      const [, mechanism, initial] = rest.split(' ')
      commands.push(`AUTHENTICATE ${mechanism ?? ''}`)
      if (initial === undefined) {
        credentialNext = tag
        send('+ ')
      } else {
        loggedIn = true
        send(`${tag} OK [CAPABILITY ${GMAIL_CAPABILITY_AFTER}] user authenticated (Success)`)
      }
      return
    }
    if (verb === 'LOGIN') {
      commands.push('LOGIN')
      loggedIn = true
      send(`${tag} OK [CAPABILITY ${GMAIL_CAPABILITY_AFTER}] logged in`)
      return
    }
    commands.push(rest)

    switch (verb) {
      case 'CAPABILITY':
        send(`* CAPABILITY ${loggedIn ? GMAIL_CAPABILITY_AFTER : GMAIL_CAPABILITY_BEFORE}`)
        return send(`${tag} OK Thats all she wrote!`)
      case 'ID':
        send('* ID ("name" "GImap" "vendor" "Google, Inc.")')
        return send(`${tag} OK Success`)
      case 'NAMESPACE':
        send('* NAMESPACE (("" "/")) NIL NIL')
        return send(`${tag} OK Success`)
      case 'LIST':
      case 'LSUB':
      case 'XLIST':
        send(`* ${verb} (\\HasNoChildren \\Subscribed) "/" "INBOX"`)
        return send(`${tag} OK Success`)
      // SELECT is answered like EXAMINE ON PURPOSE: the test's lists must be what catches it, not a
      // failed run (proved in red when this was written).
      case 'SELECT':
      case 'EXAMINE':
        send('* FLAGS (\\Answered \\Flagged \\Draft \\Deleted \\Seen)')
        send('* OK [PERMANENTFLAGS ()] Flags permitted.')
        send('* OK [UIDVALIDITY 1] UIDs valid.')
        send('* 1 EXISTS')
        send('* 0 RECENT')
        send(`* OK [UIDNEXT ${mail.uid + 1}] Predicted next UID.`)
        return send(`${tag} OK [READ-ONLY] INBOX selected. (Success)`)
      case 'UID SEARCH':
      case 'SEARCH':
        if (upper.includes(' RETURN ')) send(`* ESEARCH (TAG "${tag}") UID ALL ${mail.uid}`)
        else send(`* SEARCH ${mail.uid}`)
        return send(`${tag} OK SEARCH completed (Success)`)
      case 'UID FETCH':
      case 'FETCH':
        socket.write(fetchResponse(rest, mail))
        return send(`${tag} OK Success`)
      case 'NOOP':
        return send(`${tag} OK Success`)
      case 'LOGOUT':
        send('* BYE LOGOUT Requested')
        send(`${tag} OK 73 good day (Success)`)
        socket.end()
        return
      default:
        send(`${tag} BAD Unknown command`)
    }
  }
}

/** The items of a FETCH, split at the top level: `BODY.PEEK[HEADER.FIELDS (a b)]<0.10>` is one token. */
export function fetchItems(command: string): readonly string[] {
  const open = command.indexOf('(')
  if (open === -1) return command.split(' ').slice(3)
  const inner = command.slice(open + 1, command.lastIndexOf(')'))
  const items: string[] = []
  let depth = 0
  let current = ''
  for (const char of inner) {
    if (char === '(' || char === '[' || char === '<') depth += 1
    if (char === ')' || char === ']' || char === '>') depth -= 1
    if (char === ' ' && depth === 0) {
      if (current !== '') items.push(current)
      current = ''
    } else {
      current += char
    }
  }
  if (current !== '') items.push(current)
  return items
}

function fetchResponse(command: string, mail: ServedMail): string {
  const parts: string[] = [`UID ${mail.uid}`]
  const literals: string[] = []
  const mime = 'Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 7bit\r\n\r\n'
  for (const item of fetchItems(command)) {
    const upper = item.toUpperCase()
    if (upper === 'UID') continue
    if (upper === 'FLAGS') parts.push('FLAGS ()')
    else if (upper === 'INTERNALDATE') parts.push(`INTERNALDATE "${mail.internalDate}"`)
    else if (upper === 'X-GM-MSGID') parts.push(`X-GM-MSGID ${mail.gmailId}`)
    else if (upper === 'RFC822.SIZE') parts.push(`RFC822.SIZE ${mail.headers.length + mail.body.length}`)
    else if (upper === 'ENVELOPE') {
      const [local, domain] = mail.fromAddress.split('@')
      const [toLocal, toDomain] = mail.toAddress.split('@')
      const from = `(("${mail.fromName}" NIL "${local}" "${domain}"))`
      parts.push(
        `ENVELOPE ("${mail.internalDate}" "${mail.subject}" ${from} ${from} ${from} ((NIL NIL "${toLocal}" "${toDomain}")) NIL NIL NIL "${mail.messageId}")`,
      )
    } else if (upper === 'BODYSTRUCTURE') {
      parts.push(`BODYSTRUCTURE ("TEXT" "PLAIN" ("CHARSET" "utf-8") NIL NIL "7BIT" ${mail.body.length} 1 NIL NIL NIL NIL)`)
    } else if (upper.startsWith('BODY.PEEK[') || upper.startsWith('BODY[')) {
      const section = item.slice(item.indexOf('[') + 1, item.lastIndexOf(']'))
      const partial = /<(\d+)(?:\.\d+)?>$/.exec(item)
      const upperSection = section.toUpperCase()
      const content = upperSection.startsWith('HEADER') ? mail.headers : upperSection.endsWith('.MIME') ? mime : mail.body
      const start = partial === null ? 0 : Number(partial[1])
      const slice = content.slice(start)
      literals.push(`BODY[${section}]${partial === null ? '' : `<${start}>`} {${Buffer.byteLength(slice)}}\r\n${slice}`)
    }
  }
  return `* 1 FETCH (${[...parts, ...literals].join(' ')})\r\n`
}
