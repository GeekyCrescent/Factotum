# Inbox: a digest of your mail, when you ask for it

The `inbox` module reads the last 48 hours of one or more Gmail inboxes, has Claude sort them into
**to do**, **unsubscribe**, **spam** and **info**, ranks the to-dos, drafts replies, and shows the result
at `/m/inbox`. It runs when you press **Check mail**, and never on its own.

**It only informs.** It does not unsubscribe, move, archive, delete, label or mark anything as read,
and it never sends mail. Drafts stay in factotum until you copy one.

Why it is built this way is [ADR-0018](adr/0018-mail-digest-on-demand.md).

## 1. An app password, and what it can do

The module signs in over IMAP with a Google **app password**:

1. Turn on 2-Step Verification in your Google account.
2. Create an app password (Google Account → Security → App passwords), named e.g. `factotum`.
3. Save it in a file only you can read, without it passing through your shell history:

   ```sh
   mkdir -p ~/.factotum/secrets && chmod 700 ~/.factotum/secrets
   read -rs PW && printf '%s\n' "$PW" > ~/.factotum/secrets/gmail-personal && unset PW
   chmod 600 ~/.factotum/secrets/gmail-personal
   ```

   Google shows it in four groups of four letters; the spaces are fine, they are removed.

The file is read **at every check**, so changing the password needs no restart. A file that is a
symbolic link, readable by the group or others, empty, or over 1 KiB fails that account in that check,
with the reason on screen. The other accounts still run.

> **What this password can do: everything.** An app password is not a read-only token. With it
> anyone can read, move and delete your mail over IMAP and **send mail as you** over SMTP. factotum only
> reads — it opens the inbox with `EXAMINE` and fetches with `BODY.PEEK`, and a test checks the commands
> it sends — but that is factotum's discipline, not a limit of the password.
>
> **Who can read the file:** you, and **any agent session factotum launches**, because sessions run
> as your user. Reading files is never asked about, and `Bash` is not checked
> ([running-agents.md](running-agents.md)). The macOS Keychain would not change that: an agent with
> `Bash` can call `security` too.
>
> **To revoke it**, delete it in Google Account → Security → App passwords. That cuts factotum off at
> once and leaves your account password untouched. Do it if you ever suspect the file was read.

## 2. The config

In `~/.factotum/<env>/config.json`, then restart the daemon (the config is read at startup):

```json
"inbox": {
  "enabled": true,
  "model": "haiku",
  "accounts": [
    {
      "id": "personal",
      "label": "Gmail",
      "host": "imap.gmail.com",
      "user": "you@gmail.com",
      "passwordFile": "/Users/you/.factotum/secrets/gmail-personal",
      "read": "unread",
      "sources": [
        { "id": "uni", "label": "University", "address": "you@students.example.edu", "read": "all" }
      ]
    }
  ]
}
```

| Field | Default | What it is |
|---|---|---|
| `model` | `haiku` | Passed to `claude --model`. Lower case letters, digits, `.` and `-`; never starts with `-` |
| `effort` | none | `low`, `medium` or `high`, passed as `--effort` |
| `windowHours` | `48` | How far back a check looks, from the moment you press |
| `keepDays` | `30` | Checks older than this are deleted |
| `accounts[].read` | `unread` | `unread`: only mail without `\Seen`; `all`: everything in the window |
| `sources[].read` | `all` | The same, for mail forwarded from that source |

The port is always 993 with verified TLS; there is nothing to configure. Every object refuses keys it
does not know. A mistake switches off **only** `inbox`, with the reason in the daemon's log and in
`factotum doctor`, and the reason never quotes a value.

## 3. Other accounts, by forwarding

Accounts that do not allow an app password — institutional Outlook, typically — come in **forwarded
to a Gmail account you already read**, and are recognised as **sources** of that account:

- **Outlook** redirecting puts the forwarding mailbox in `Resent-From`.
- **Gmail** forwarding puts it as the first address of `X-Forwarded-For`, and in a second `Delivered-To`.
- Failing those, the source's address in `To` or `Cc`.
- `From` never counts: a colleague writing straight to your Gmail is mail of that Gmail.

A mail that matches a source shows that source's label; anything else shows the account's.

**Use `read: "all"` for a forwarded source.** A forwarded copy arrives unread in Gmail whether or not
you read the original, so "unread" says nothing about it.

If an institution blocks forwarding to outside addresses, that account cannot be included. There is
no workaround in this module.

## 4. What goes to Claude

For every mail in the window, in batches of 40, by **stdin** to `claude -p`:

- the sender, the subject, the date, the source's label;
- whether it has a `List-Unsubscribe` header, and how many attachments it has (attachments are never
  downloaded);
- **up to 4,000 characters of its text**: the first `text/plain` part, or the `text/html` one with the
  tags removed. Quoted lines (`>`) are dropped.

`claude` runs with no tools, no MCP servers, no settings and no session persistence, so a mail that
gives orders has nothing to carry them out with. At worst it is classified wrong, and you see the
result before acting on it. Every check spends from your Claude plan at the moment you press. The
screen's foot shows the tokens, the equivalent API cost and the time.

At most 400 mails per check, the newest. The screen says how many were left out.

## 5. What is kept, and how to delete it

- `~/.factotum/<env>/modules/inbox/digests/<id>.json`, one per check, `0600` in a `0700` folder.
  Each one holds every mail's sender, subject, date, source, category, the to-do and its draft, and a
  link to open the mail in Gmail. **Never the body.**
- Deleted after `keepDays` (30), at startup and after every check.
- The daemon's log gets one line per check — counts, tokens, cost, time — and never a sender, a
  subject or a body.

To delete everything: `rm -r ~/.factotum/<env>/modules/inbox`. To stop: `"enabled": false`, or remove
the block, and revoke the app password.

## 6. Choosing the model

The rule is **the cheapest model that works**: three days on the same real mail per candidate; one
missed to-do, or more than two spam/unsubscribe mistakes in one check, rules a candidate out. Haiku
costs about $0.10 per batch of 40 and Sonnet about $0.23 (measured with synthetic mail; Haiku with
`--effort low` saved nothing). The default is `haiku` while that comparison runs on real mail.

## 7. The screen

`/m/inbox` puts what asks for you first. **To do** opens; **Unsubscribe**, **Info** and **Spam** start
folded, and a tap on any heading folds or opens it. Each has its own colour: to do red, unsubscribe
orange, info teal, spam pink. A red dot marks an urgent to-do, and a due date that is today or past
is red too.

Each to-do is its ask and one line: when it is due, who sent it, the source, and "seen last time".
The two icons copy the draft (it turns into a check for two seconds) and open the mail in Gmail. A
tap on the text shows the subject, why it is a to-do, and the whole draft.

The spec asked for a screen with text only (D9). Copy and Open in Gmail became icons after the
screen was tried on the phone, each with its own label for a screen reader. Nothing else on the
screen is a glyph but the caret that folds a section.
