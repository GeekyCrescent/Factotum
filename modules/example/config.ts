/**
 * The module's own config fragment. It lives under `modules.example` in
 * `~/.factotum/<env>/config.json`.
 *
 * EVERY FIELD HAS A DEFAULT, on purpose. A module that cannot start without being
 * configured is badly designed: its default is "off", and turning it on should be
 * one key. Anything that genuinely needs a secret takes a PATH to a file outside the
 * repository, never the value.
 *
 * ONE TRAP, and it is the one that bites everybody: this schema drops keys it does
 * not know, exactly like the root one. That is harmless while a module only READS
 * its fragment. The moment one re-reads and writes it back, every unknown key is
 * deleted from disk. If your module ever writes its own config, add `.catchall()`.
 */

import { z } from 'zod'

export const exampleConfigSchema = z.object({
  greeting: z.string().default('hello from factotum'),
  /** Bounded so a typo cannot arm a tight loop. */
  tickSeconds: z.number().int().min(1).max(3600).default(30),
})

export type ExampleConfig = z.infer<typeof exampleConfigSchema>
