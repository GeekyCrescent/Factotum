/**
 * «Save as a rule for all?» (spec 2026-11-12-postulaciones, requirements crit. 33; design D7, D15).
 * Pure: an instruction is offered as a rule when `always`, `never`, `siempre` or `nunca` opens it, or
 * opens one of its comma-separated parts. Anywhere else the word is ordinary prose («as always»).
 */

/** The word, after optional spaces and opening quotes or brackets, and followed by no more letters. */
const RULE_WORD = /^[\s"'«“‘(\[]*(always|never|siempre|nunca)(?![\p{L}\p{N}])/iu

export function isRuleHint(instruction: string): boolean {
  return instruction.split(',').some((part) => RULE_WORD.test(part))
}
