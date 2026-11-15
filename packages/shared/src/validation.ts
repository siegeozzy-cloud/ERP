import { z } from 'zod'

// Field rules shared by the API (which is the one that counts) and the forms on web and mobile
// (which say what's wrong before anything is sent). Ported from Memoir.
//
// Injection is handled by the database layer: every query drizzle builds is parameterised. These rules
// are the second line: a box that only holds the characters its field needs can't carry a payload on
// towards a log line, an email header or a page. Passwords are the exception on purpose, below.

/**
 * Letters, digits and the four separators real addresses use (`.`, `_`, `+`, `-`). Everything else
 * RFC 5322 technically permits is refused: no mail provider issues addresses with it.
 */
const EMAIL_SHAPE = /^[a-z0-9]([a-z0-9._+-]*[a-z0-9])?@([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/
const BAD_EMAIL_CHARS = 'Emails can use letters, digits and . _ + - only — leave out other symbols.'

/** Control codes and line separators: they can't be typed back reliably and can split log lines. */
const INVISIBLE = /[\p{Cc}\p{Zl}\p{Zp}]/u
const NO_INVISIBLE = 'Leave out tabs, line breaks and other invisible characters.'

export const emailSchema = z
  .string('Enter your email.')
  .trim()
  .toLowerCase()
  .min(1, 'Enter your email.')
  .max(254, 'That email is too long.')
  // first, so a refused character is named as one rather than reported as a malformed address
  .refine((v) => !/[^a-z0-9@._+-]/.test(v), BAD_EMAIL_CHARS)
  .pipe(z.email('Enter a valid email address, like you@example.com.'))
  .refine((v) => EMAIL_SHAPE.test(v) && !v.includes('..'), 'Enter a valid email address, like you@example.com.')

/**
 * New passwords. Every printable character in any script is allowed, because length and variety are
 * what make a password hard to guess, and it is hashed with Argon2id the moment it arrives.
 */
export const passwordSchema = z
  .string('Enter a password.')
  .min(8, 'Use at least 8 characters for your password.')
  .max(128, 'Use 128 characters or fewer for your password.')
  .refine((v) => !INVISIBLE.test(v), NO_INVISIBLE)

/** The sign-in password box: no minimum length, so an account made under older rules still gets in. */
export const existingPasswordSchema = z
  .string('Enter your password.')
  .min(1, 'Enter your password.')
  .max(128, 'Use 128 characters or fewer for your password.')
  .refine((v) => !INVISIBLE.test(v), NO_INVISIBLE)

export const nameSchema = z
  .string('Enter your name.')
  .transform((s) => s.trim().replace(/\s+/g, ' '))
  .pipe(
    z
      .string()
      .min(1, 'Enter your name.')
      .max(80, 'Use 80 characters or fewer for your name.')
      .regex(/^[\p{L}\p{M}][\p{L}\p{M}' .-]*$/u, "Names can use letters, spaces, apostrophes ( ' ), hyphens ( - ) and periods."),
  )

/** The single-use token from a confirmation or reset link: base64url, 43 characters as made. */
export const linkTokenSchema = z
  .string('That link doesn’t work anymore.')
  .trim()
  .min(1, 'That link doesn’t work anymore.')
  .max(128, 'That link doesn’t work anymore.')
  .regex(/^[A-Za-z0-9_-]+$/, 'That link doesn’t work anymore.')
