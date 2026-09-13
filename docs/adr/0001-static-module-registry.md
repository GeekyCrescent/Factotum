# 1. Modules are registered statically, and switched on by config

**Status:** accepted

## Context

The predecessor project wired twelve domain modules by hand in one 59-import file.
Adding one meant editing that file, the config schema and the client; switching one
off meant recompiling. Factotum exists largely to fix that.

The obvious fix is a plugin loader: scan `modules/*`, `import()` what is there.

## Decision

Modules are listed in a TypeScript barrel (`modules/index.ts` for bundled ones,
`modules/local.ts` for yours) and **switched on or off by a key in the config**, with
no rebuild.

## Why not dynamic loading

- **Type checking is the entire value of the contract.** A dynamic `import()` returns
  `unknown`, which moves contract validation to runtime — precisely when it is too
  late. With a barrel, a module that does not satisfy `FactotumModule` does not
  compile.
- **The bundler has to see it.** A module ships a screen as well as a server half,
  and Vite cannot bundle what is not in the import graph.
- **The actual complaint was not about loading.** It was "switching a module on and
  off requires a recompile", and a config key solves that. Two different problems were
  being conflated.

## Consequence

Installing a third-party module is **one line in `modules/local.ts`**, and a fork
carries that one-line diff forever. That is the price, and it is cheap compared with
losing the type check.
