/** Test doubles, under the `@factotum/mail/testing` subpath so no production code imports them (design D4). */

export {
  fetchItems,
  GMAIL_CAPABILITY_AFTER,
  GMAIL_CAPABILITY_BEFORE,
  startFakeImap,
  type FakeImapServer,
  type ServedMail,
} from './test-imap-server.ts'
export { imapDouble, type Call, type DoubleOptions, type FakeMail, type ImapDouble, type Stall } from './test-imap-client.ts'
export {
  GMAIL_ACCEPTED,
  GMAIL_BAD_CREDENTIALS,
  GMAIL_EHLO,
  startFakeSmtp,
  type FakeSmtpOptions,
  type FakeSmtpServer,
  type SmtpCut,
  type SmtpStep,
} from './test-smtp-server.ts'
