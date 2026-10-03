# 15. Dictation is a capability of the sessions module, transcribed by a third party

**Status:** accepted

## Context

The owner wants to speak a prompt instead of typing it, from the phone above all. The box is the
composer, and the composer belongs to the sessions module. Transcription has to happen somewhere
that can hold an API key: the host.

Four things were measured before anything was written down (Groq, `whisper-large-v3-turbo`):

- **Over silence the provider invents a sentence** — "Thank you.", "Gracias.", once "Terima kasih sudah
  menonton" — and nothing in its answer says so. Three measurements, three inventions.
- **The file name decides whether it takes the audio.** The same bytes named `.bin` come back 400.
- **On the owner's phone, silence is exact zeros**: Chrome's default noise suppression gates the
  background, so a level meter with a small threshold tells silence from speech reliably.
- **With the screen locked, Android cuts the microphone** (digital silence after ~10 s) — and the
  provider invents over that too.

## Decision

- **It lives in `modules/sessions/dictation/`, not in a module of its own.** A screen can only call its
  own module (`apiFor(id)`), so a separate `dictation` module would have needed the shell to inject a
  `dictate(audio)` capability into the sessions screen — closing the client edge ADR-0005 left open, for
  one consumer. The folder **imports nothing from the rest of the module** (a grep checks it), so the day a
  second module wants dictation, moving the folder out is the migration, and the client edge is decided
  then.
- **The engine does not know about it.** Dictation needs no session, site or lock, and `/setup` comes
  whole from the engine, so availability has its own route: `GET /dictation` answers `{ on: { maxSeconds,
  maxBytes } }` or `{ off: reason }`.
- **The block is data in the main schema, interpreted in `start()`.** `sessionsConfigSchema` carries
  `dictation` as `z.unknown()`; `dictation/config.ts` parses it with a `strictObject`. A typo there
  switches off dictation with a reason — including a misspelt key, which `z.object` would have dropped in
  silence — and never costs the sessions (ADR-0004). Nothing that can fail at start throws.
- **The audio is an upload** (`uploadRoute`, ADR-0012). The kernel writes it under `.incoming/`, the
  handler reads it and keeps nothing, and the kernel deletes it before answering — also when the handler
  throws — and sweeps the folder at boot. No new kernel capability.
- **No new error codes.** `ERROR_CODES` is the core's closed list. Off is `409 conflict` with
  `dictation.off`, the shape of uploads switched off. The provider failing is `502 module-error` with
  `dictation.failure` (`credential`, `quota`, `failed`). `module-error` is the nearest code in the list,
  not an exact one; an `upstream` code would be cleaner and would mean touching the core. **The screen
  decides by `dictation.failure`, never by the status**: `tailscale serve` answers 502 in plain text when
  the daemon is down, and that must read as "could not reach Factotum", not as the provider.
- **Silence is stopped on the phone.** The screen samples the level every 100 ms on an `AudioContext`
  created in the tap (one created after the permission dialog can start suspended), and does not send a
  recording that never crossed the threshold. When the meter cannot be trusted it sends anyway: the
  transcript is appended to the box and never sent by itself, so the owner always reads it first.

## Consequences

- **The audio leaves the host for a third party.** Off unless the owner configures a key; the
  documentation says so in its first sentence.
- **While a request lasts, the `.part` is `0644` in a `0755` folder** (measured, umask 022): another user
  of the machine could read it for those seconds. Closing that means the kernel choosing the file mode,
  which is a kernel change and not this ADR.
- **The key is read once, at start.** Changing it means restarting the daemon.
- **A request in flight when the daemon stops is not aborted by its own timeout**: stopping disposes the
  module's timers. Its answer goes nowhere, and the process is on its way out.
- **A locked screen is not handled.** The owner does not lock the phone while dictating; if it happens,
  what was recorded is sent and the provider may invent.

## What this does not do

- Read answers aloud, dictate into other boxes, or offer another provider or a local model.
- Derive the vocabulary from projects or agents: a short list written by hand did five times better in
  the predecessor, and a whole catalogue did as well as nothing.
- Stream, keep the audio, or send by voice.
