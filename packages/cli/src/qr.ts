/**
 * The QR.
 *
 * The phone needs the URL either way, and typing `http://100.87.12.34:7777` on a
 * phone keyboard is where an installation gets abandoned. This is onboarding, not
 * security: there is no credential to carry, only an address.
 */

import { toString as qrToString } from 'qrcode'

export async function printQr(url: string, out: (line: string) => void): Promise<void> {
  try {
    const art = await qrToString(url, { type: 'terminal', small: true })
    out(art.replace(/\n$/, ''))
  } catch {
    // A terminal that cannot draw it is not a reason to fail: the URL is two lines up.
    out(`(could not draw a QR here — the URL is ${url})`)
  }
}
