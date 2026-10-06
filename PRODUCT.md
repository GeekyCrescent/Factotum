# Product

## Register

product

## Users

One person: the owner of the machines factotum runs on. They reach it from their phone (an installed
PWA, 360–390 px, often one-handed, between other things) and from their Mac. Each screen serves a
short visit: see what changed, decide, act, leave. Agents run on the machines; factotum is the door.

## Product Purpose

A modular remote client for Claude Code over Tailscale. The kernel does nothing on its own; modules
add what it can do (launch and watch agent sessions, approve writes, digest the inbox). Success is a
visit measured in seconds: the owner sees what needs them, acts on it, and puts the phone away.

## Brand Personality

Calm, plain, exact. A quiet tool that reads like a well-kept notebook rather than an app competing
for attention. Typography and spacing carry hierarchy; colour appears only when it means something
(an accent for the one action, red for failure, amber for something waiting on the owner). Copy is
short, declarative and literal: it says what happened and what a button will do, never sells.
Screens use text, not icon decoration.

## Anti-references

- Gmail / Outlook: toolbars of icons, dense chrome, every message dressed the same, actions hidden
  behind glyphs.
- By extension: SaaS dashboards with metric cards and badges everywhere; anything that looks busy
  before it looks useful.

## Design Principles

1. **What needs me comes first.** Each screen leads with the one thing the owner must decide or do;
   everything else is folded, dimmed or moved below.
2. **Seconds, not minutes.** Optimise for a glance on a phone: the answer is visible without
   scrolling or opening anything.
3. **Colour is a signal, never decoration.** If a colour does not mean something, it is the neutral.
4. **Say exactly what is true.** Plain words, real numbers, honest states (failed, partial, running).
5. **Phone first, Mac as well.** Designed at 360 px and one thumb; it must still read well in a wide
   window.

## Accessibility & Inclusion

WCAG 2.2 AA: 4.5:1 for text (3:1 for large), 44 px minimum touch targets, visible focus, every
animation with a `prefers-reduced-motion` alternative. Light and dark follow the system and both
pass the contrast test in `apps/web/src/contrast.ts`.
