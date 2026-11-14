/**
 * A sheet keeps the focus (design D15; review finding 5): Tab never reaches «Approve» behind the
 * scrim. Pure: `sheet.tsx` lists the sheet's focusable controls and asks where Tab goes.
 */

/**
 * Where Tab (or Shift+Tab, `back`) moves the focus, given the index of the focused control among the
 * sheet's `count` (-1: outside them, or on the title): the index to focus, or null to let the browser
 * move it — it stays inside on its own.
 */
export function trappedFocus(current: number, count: number, back: boolean): number | null {
  if (count === 0) return null
  const last = count - 1
  if (current < 0) return back ? last : 0
  if (back && current === 0) return last
  if (!back && current === last) return 0
  return null
}
