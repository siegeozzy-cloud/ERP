// What the API sends back. The API builds these; web and mobile read them.

/** Every error looks like this. `message` is written for people; `field` names the form input it's about. */
export type ApiErrorBody = { error: { code: string; message: string; field?: string } }

export type PublicUser = { id: string; name: string; email: string }

export type Session = { user: PublicUser }

/** POST /api/auth/signin. `token` is for clients that can't use the cookie (phone app, cross-site web). */
export type SignInResponse = Session & { token: string }

/**
 * Sign-up, resend and forgot-password all answer "check your inbox".
 * `delivery: 'console'` means no mail server is set up and the link was printed in the API's terminal.
 */
export type CheckInboxResponse = { status: 'verify-email' | 'reset-sent'; email: string; delivery: 'email' | 'console' }

/** Where the emailed links land in the web app, and the result they carry. */
export type VerifyResult = '1' | 'invalid' | 'expired'
