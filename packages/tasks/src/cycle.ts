/**
 * Weekly cycles: the ISO week of a moment in the board's time zone (spec 2026-10-14, design D4).
 */

/** `YYYY-Www`, the week ALWAYS with two digits: `2026-W9` is not a cycle (criterion 14). */
export const CYCLE_ID_PATTERN = /^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$/
