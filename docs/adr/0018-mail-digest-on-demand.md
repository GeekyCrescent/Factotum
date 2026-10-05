# 18. A mail digest, on demand, read over IMAP and classified by the CLI

**Status:** accepted. A new module, `inbox`, and a new workspace package, `packages/inbox`, built the
way `sessions` is (ADR-0005). The kernel and `packages/core` do not change.

## Context

The owner reads several mailboxes — two Gmail accounts and institutional Outlook accounts — to find
what asks something of them, what is junk, and what is worth unsubscribing from. What needs action is
lost among newsletters. The wish: one button that reads the last 48 hours, sorts it, ranks the to-dos,
drafts the replies, and changes nothing in any mailbox.

Measured before deciding:

- **A schedule does not work on this machine.** With the lid closed the Mac sleeps and wakes in the
  dark every ~15 minutes for 45–60 s, and an active `caffeinate -i` did not stop it going back to
  sleep. Running at midnight would need `pmset` with `sudo` and a recovery margin.
- **`claude -p` classifies without tools and returns JSON that fits a schema.** With `--tools ""`
  and `--json-schema`, `structured_output` arrives as an object that matches the schema; the CLI uses an
  internal tool for it and that works with `--tools ""`. A mail written as a prompt injection was
  classified as spam and not followed. Measured on CLI 2.1.289: the schema has to declare **draft-07**.
  A draft 2020-12 `$schema`, which is zod's default, is refused with exit 1.
- **A 40-mail batch of ~160 KB goes by stdin** and takes 26–38 s.
- **Institutional tenants do not let an outside app in.** Through Microsoft Graph with a public client,
  one tenant answered, but with ~40 pre-consented scopes including `Files.ReadWrite.All` and
  `Sites.FullControl.All`. The other refused by conditional access. Both did allow **forwarding** to a
  Gmail account.
- **Google OAuth in "Testing" loses its refresh token after 7 days.** An app password over IMAP does
  not expire, and needs 2-step verification on the account.
- **`imapflow` 2.2.5 reads without marking anything read**: `mailboxOpen(…, { readOnly: true })` sends
  EXAMINE, and every part is fetched with `BODY.PEEK`. It also sends more than that on its own — LIST
  before EXAMINE, CAPABILITY, ID, NAMESPACE, AUTHENTICATE — and IDLE, COMPRESS, ENABLE and BINARY unless
  told not to.

## Decision

- **On demand only.** A run starts when the owner presses "Check mail" (`POST /run`, 202 at once). It
  goes on in the daemon if the app is closed, and the screen polls `GET /status` to show where it is.
  One run at a time: pressing again during a run gets 409. Nothing is scheduled.
- **Not a session.** A run has no project, no tools and no conversation, and must not appear in the
  session history. It is the titler's pattern made bigger: `claude -p` in its own process group, in an
  empty `<state>/run` directory, killed on a timeout armed with the kernel's timers. It is not
  `runAgent`. The prompt goes by **stdin**, never in argv, and stdin carries an `error` listener so an
  EPIPE from a CLI that exited early fails the batch instead of the daemon.
- **IMAP with an app password, read-only.** The password is read at every run from a file that must be
  a regular file (not a symlink) with mode `0600` or stricter. It is never in the config, the log, a
  digest or a reason. TLS on port 993 only, verified.
- **Two lists of IMAP commands**, and a protocol test that runs the real `imapflow` against a fake TLS
  server announcing Gmail's measured `CAPABILITY`:
  - **forbidden**, with or without a `UID` prefix: `SELECT`, `STORE`, `COPY`, `MOVE`, `EXPUNGE`,
    `APPEND`, `CREATE`, `DELETE`, `RENAME`, `SUBSCRIBE`, `UNSUBSCRIBE`, `IDLE`; and in `FETCH`, any item
    that sets `\Seen` — `BODY[…]` or `BINARY[…]` without `.PEEK`, `RFC822`, `RFC822.TEXT`, compared by
    exact token;
  - **allowed**: `CAPABILITY`, `ID`, `NAMESPACE`, `LOGIN`/`AUTHENTICATE`, `LIST`, `LSUB`, `XLIST`,
    `EXAMINE`, `SEARCH`/`UID SEARCH`, `FETCH`/`UID FETCH` with the items above, `NOOP`, `LOGOUT`.

  The client is built with `disableAutoIdle`, `disableCompression`, `disableBinary` and
  `disableAutoEnable`. The code only reaches the library through `ImapClient`, a type that declares
  no method that writes.
- **Bodies are fetched once per MIME part number, cut at 64 KiB by the server** —
  `BODY.PEEK[n]<0.65536>` for every mail sharing that part — not with one `download()` per mail. Gmail
  answers each command in about half a second, so 41 mails cost ~41 s one at a time and ~2 s together.
  The transfer encoding and the charset are undone in the package.
- **Forwarded accounts are sources inside one account.** A mail forwarded by Outlook carries the
  forwarding mailbox in `Resent-From`; one forwarded by Gmail carries it as the first address of
  `X-Forwarded-For`. `From` never makes a source. A source reads `all` by default: a forwarded mail
  arrives unread whatever happened to it at its origin.
- **What is kept**: one `0600` JSON file per run in a `0700` directory, with sender, subject, date,
  source, the classification, the draft and a link to the mail in Gmail — **never the body**. Kept 30
  days by default, pruned by the date in the file name.
- **Thin module, injected package.** `modules/inbox` carries its config as `z.unknown()`, so a bad
  block switches off `inbox` with its reason in the log and nothing else. It declares the package's
  types by hand, and `main.ts` ties the two copies with `const inboxFactory: CreateInbox = createInbox`.
  This is the **third** place with that pattern. ADR-0005 said to revisit it at the third; it was
  revisited, and it stays: it works, and a shared home for the types is its own change.
- **`imapflow` 2.2.5, pinned exactly.** It is the first runtime dependency that talks to a service
  outside the machine, and it brings eight transitive dependencies (`pino`, `iconv-lite`, `libmime`,
  `socks`…). Writing an IMAP client by hand is the alternative; EXAMINE and PEEK do not justify it.

## Consequences

- **The accepted risk: an app password can do everything with the account**, not only read: IMAP
  writes and SMTP included. "Read-only" is the client's discipline, not the credential's. And the file
  can be read by any agent session factotum launches, as the same user: reading is never asked about,
  and `Bash` is not checked. Mitigated, not solved: the password is per-application, so it can be
  revoked on its own without changing the account's password. Keeping it in the macOS Keychain would
  not help, because an agent with `Bash` can call `security` too.
- **The mail goes to Claude** — sender, subject, date and up to 4,000 characters of the body of every
  mail in the window, through the owner's CLI and subscription. A run spends from the 5-hour window at
  the moment the owner presses the button. The JSON reports `total_cost_usd` (an indicator, not the
  quota) and the screen shows it.
- **Prompt injection can steer a classification or a draft**, never an action: there are no tools.
  Every string from a mail is XML-escaped inside `<email>` delimiters, and the prompt says that content
  is data. The owner reads every draft before copying it.
- **Nothing is done to the mail.** No unsubscribing, moving, archiving, deleting, labelling or
  marking as read. Drafts live only in factotum.
- **Behind a slow route, Node's default connect is too impatient.** Happy Eyeballs gives each address
  250 ms; measured behind a VPN, a connect to Gmail took 280–560 ms with IPv6 unreachable, so every
  address "timed out". The client passes `autoSelectFamilyAttemptTimeout: 2500`.
- A failed run still writes its digest and a log line. "Seen last time" compares with the last run
  that did not fail.

## Going back

Remove `modules.inbox` from the config, or set `enabled: false`. The state stays on disk unread;
`rm -r ~/.factotum/<env>/modules/inbox` removes it. Revoke the app password in the Google account.

## Alternatives considered

- **Microsoft Graph** for the institutional accounts. It needs an app registration that the tenants
  either over-consent or refuse; forwarding needs neither.
- **Google OAuth.** In "Testing" mode the refresh token dies in 7 days, and publishing an app is out
  of proportion.
- **Running in the cloud** (scheduled cloud agents). The mail would leave the machine for a third
  place, and the app password with it.
- **A schedule** (midnight, on wake). Measured above: it needs `pmset`, `sudo` and a margin, and the
  owner reads mail when they press the button anyway.
- **`mailparser`.** `imapflow` already returns the structure and the parts; undoing a transfer
  encoding and a charset is a few lines.
