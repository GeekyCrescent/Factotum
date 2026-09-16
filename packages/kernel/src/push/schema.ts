/**
 * The body of `POST /push/subscriptions`, validated at the boundary like everything that
 * crosses HTTP (CLAUDE.md §1).
 *
 * The bounds are guardrails, not measurements of any one push service: what a real Chrome 153
 * sent to FCM was an 188-character endpoint, an 87-character p256dh and a 22-character auth
 * (spec A5/A6). They exist so a POST cannot grow `subscriptions.json` without limit — the
 * route has no credential, so anything on this machine can call it (spec §5).
 */

import { z } from 'zod'

const MAX_ENDPOINT_LENGTH = 2048
const MAX_KEY_LENGTH = 256
const BASE64URL = /^[A-Za-z0-9_-]+$/

const base64url = z.string().min(1).max(MAX_KEY_LENGTH).regex(BASE64URL, 'must be base64url without padding')

const httpsEndpoint = z
  .string()
  .max(MAX_ENDPOINT_LENGTH)
  .refine(
    (v) => {
      try {
        // No Web Push over plain HTTP: accepting one would store something that can only fail.
        return new URL(v).protocol === 'https:'
      } catch {
        return false
      }
    },
    { message: 'endpoint must be an https: URL' },
  )

/** `expirationTime` and anything else the browser adds are dropped: we store what we send with. */
export const subscriptionSchema = z.object({
  endpoint: httpsEndpoint,
  keys: z.object({ p256dh: base64url, auth: base64url }),
})
