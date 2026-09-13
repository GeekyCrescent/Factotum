# 4. Configuration errors degrade; programming errors abort

**Status:** accepted

## Context

A module's config can be wrong in ways the kernel cannot fix — a path to a key file
that does not exist, a number out of range. The choice is whether that stops the
daemon.

## Decision

> **Abort** anything that compromises the **network surface** or the **identity of
> the process**: where it listens, which environment it believes it is in, and whether
> two modules claim the same id.
>
> **Degrade** anything confined to a **single module**.

A module whose fragment does not validate, or whose `start` throws or hangs, is
**disabled with the reason recorded**. Its routes answer `501` with that reason,
`GET /modules` lists it, `factotum doctor` reports it, and everything else runs.

## Why

The predecessor project reached the same conclusion and left the argument in its
source: *"a mistyped apiKeyPath cannot leave anyone without Jarvis"*. One broken
credential path should not cost you the whole system at the moment you need it.

The inverse — abort on anything wrong — was this project's first draft, and it turned
"the transit API key is missing" into "nothing starts".

## Consequence

A disabled module can go unnoticed until someone looks. That is the price, and it is
why `doctor` asks a running daemon rather than only reading files: disabled-ness
exists only in the live process, and persisting it would create a second source of
truth that goes stale on the next restart.
