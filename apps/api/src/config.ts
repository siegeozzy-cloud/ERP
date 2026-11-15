import { APP_NAME } from '@erp/shared'
import { z } from 'zod'

// Settings come from the environment (.env in development, the host's dashboard in production).
// The server refuses to start with a bad one.

const blankIsUnset = (v: unknown) => (v === '' ? undefined : v)
const optional = z.preprocess(blankIsUnset, z.string().optional())

/**
 * Values pasted into hosting dashboards arrive with stray quotes or spaces, or with the setting's name
 * still in front ("DATABASE_URL=postgres://…"). Those are tidied away.
 */
const pasted = (name: string) =>
  z.preprocess((v) => {
    if (typeof v !== 'string') return v
    const cleaned = v
      .trim()
      .replace(new RegExp(`^${name}\\s*=`, 'i'), '')
      .trim()
      .replace(/^(['"])([\s\S]*)\1$/, '$2')
      .trim()
    return cleaned === '' ? undefined : cleaned
  }, z.string())

const pastedOptional = <T extends z.ZodType>(schema: T) => z.preprocess(blankIsUnset, schema.optional())

/** A value copied from documentation with <placeholders> still in it. */
const hasPlaceholders = (v: string) => /[<>]/.test(v)

const Env = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  /** Only this machine in development; on a host the request comes from outside the container. */
  HOST: z.string().default(process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1'),
  PORT: z.coerce.number().int().default(4100),
  /** Where the web app is. Links in emails go here. */
  APP_URL: z.url().default('http://127.0.0.1:5180'),
  /** This server's own public address. Left out in development, where the web app proxies /api. */
  API_URL: z.preprocess(blankIsUnset, z.url().optional()),
  /** Other addresses allowed to call this API, comma separated (preview deployments). */
  EXTRA_ORIGINS: optional,
  DATABASE_URL: pasted('DATABASE_URL')
    .refine((v) => !hasPlaceholders(v), 'DATABASE_URL still has <placeholders> in it — copy the real connection string from your database host.')
    .refine((v) => /^postgres(ql)?:\/\//.test(v), 'DATABASE_URL must start with postgres:// — paste only the connection string.'),
  ENCRYPTION_KEY: pasted('ENCRYPTION_KEY').refine(
    (v) => Buffer.from(v, 'base64').length === 32,
    'ENCRYPTION_KEY must be 32 random bytes, base64 (see .env.example)',
  ),
  /** Brevo's transactional email API key. Preferred to SMTP: it's HTTPS, so blocked mail ports don't matter. */
  BREVO_API_KEY: pastedOptional(
    pasted('BREVO_API_KEY')
      .refine((v) => !hasPlaceholders(v), 'BREVO_API_KEY still has <placeholders> in it.')
      .refine((v) => v.startsWith('xkeysib-'), 'BREVO_API_KEY must start with xkeysib- (an API key, not an SMTP key).'),
  ),
  SMTP_URL: optional,
  MAIL_FROM: z.preprocess(blankIsUnset, pasted('MAIL_FROM').default(`${APP_NAME} <no-reply@erp.local>`)),
})

const parsed = Env.safeParse(process.env)
if (!parsed.success) {
  console.error('Invalid settings:\n' + parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n'))
  process.exit(1)
}

const env = parsed.data
const appOrigin = new URL(env.APP_URL).origin
const apiOrigin = env.API_URL ? new URL(env.API_URL).origin : appOrigin

const unquote = (s: string) => s.trim().replace(/^(['"])([\s\S]*)\1$/, '$2').trim()

/** `ERP <no-reply@example.com>` as its two parts: Brevo's API wants them apart. */
function mailAddress(from: string) {
  const cleaned = unquote(from)
  const m = /^([\s\S]*)<([^>]+)>$/.exec(cleaned)
  return { name: (m ? unquote(m[1]!) : '') || APP_NAME, email: (m ? m[2]! : cleaned).trim() }
}
const mailFrom = mailAddress(env.MAIL_FROM)

/** How email leaves: Brevo's API, an SMTP server, or (with neither set up) the terminal. */
const mailVia = env.BREVO_API_KEY ? ('brevo' as const) : env.SMTP_URL ? ('smtp' as const) : ('console' as const)

const badMailFrom = !/^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/.test(mailFrom.email)
  ? `“${mailFrom.email}” isn’t an address. Write it as you@example.com or ${APP_NAME} <you@example.com>.`
  : // Brevo only sends from an address you've verified, so the made-up default is refused on every send
    mailVia === 'brevo' && /\.(local|localhost|test|invalid|example|internal)$/i.test(mailFrom.email.split('@')[1]!)
    ? `“${mailFrom.email}” isn’t a real address, and Brevo only sends from one you’ve verified.`
    : null

if (badMailFrom) {
  console.error(`Invalid settings:\n  MAIL_FROM: ${badMailFrom}`)
  process.exit(1)
}

export const config = {
  ...env,
  dev: env.NODE_ENV !== 'production',
  appOrigin,
  apiOrigin,
  /** Addresses whose requests are accepted. */
  allowedOrigins: [appOrigin, ...(env.EXTRA_ORIGINS?.split(',').map((o) => o.trim()).filter(Boolean) ?? [])],
  mailVia,
  mailFrom,
  /** Whether links reach a real inbox, or are only printed in the terminal. */
  mailConfigured: mailVia !== 'console',
  encryptionKey: Buffer.from(env.ENCRYPTION_KEY, 'base64'),
}
