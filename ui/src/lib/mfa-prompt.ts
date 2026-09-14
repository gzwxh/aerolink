/**
 * Bridge between the API client (which hits `mfa_verification_required` on
 * sensitive requests) and the MFA prompt dialog rendered by the app shell.
 */
export const MFA_PROMPT_EVENT = 'kite:mfa-prompt'

type Resolver = (verified: boolean) => void

let pendingResolver: Resolver | null = null

/** Resolves `true` once the user verified a code, `false` when dismissed. */
export function requestMFAVerification(): Promise<boolean> {
  return new Promise((resolve) => {
    pendingResolver = resolve
    window.dispatchEvent(new Event(MFA_PROMPT_EVENT))
  })
}

export function resolveMFAVerification(verified: boolean) {
  pendingResolver?.(verified)
  pendingResolver = null
}
