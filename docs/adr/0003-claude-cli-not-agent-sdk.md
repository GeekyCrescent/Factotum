# 3. The engine is the Claude Code CLI, not the Agent SDK

**Status:** accepted (inherited, verified in the predecessor project)

## Context

Something has to actually run the agent. Two options: the Claude Agent SDK, or the
Claude Code CLI driven headless as a subprocess.

## Decision

**The CLI**, as a subprocess.

## Why

The Agent SDK requires an `ANTHROPIC_API_KEY` and bills per token. Anthropic's own
documentation states that third-party developers may not offer claude.ai login or
subscription rate limits for products built on the SDK. Using it would turn a tool
you run on your own laptop into a metered service.

The CLI runs on the subscription you already have. This was verified in the
predecessor project by running `claude -p --output-format json` with no API key in the
environment and getting `"provider": "firstParty"` back.

## Consequence

factotum requires `claude` on the `PATH`, signed in. `factotum doctor` checks for it.
Nothing here talks to the Anthropic API directly.
