/** The public surface of @factotum/mail (design D4). */

export {
  connectImapFlow,
  type BodyQuery,
  type ConnectImap,
  type FetchMessageObject,
  type ImapClient,
  type ImapOptions,
  type MessageStructureObject,
  type MetaQuery,
} from './imap/client.ts'
export { countAttachments, decodePart, MAX_BODY_CHARS, pickPart, plainText, type PickedPart } from './imap/body.ts'
export { addressesIn, parseHeaderBlock } from './imap/headers.ts'
export { closeQuietly, IMAP_PORT, imapOptions, reasonOf, untilAborted } from './imap/session.ts'
export { readPassword, type PasswordResult } from './secrets.ts'
export {
  connectNodemailer,
  SEND_DEADLINE_MS,
  sendMail,
  SMTP_PORT,
  smtpOptions,
  type ConnectSmtp,
  type SendInput,
  type SendResult,
  type SmtpMessage,
  type SmtpOptions,
  type SmtpPayload,
  type SmtpReply,
  type SmtpTransport,
} from './smtp.ts'
