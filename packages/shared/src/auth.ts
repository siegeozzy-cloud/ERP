import { z } from 'zod'
import { emailSchema, existingPasswordSchema, linkTokenSchema, nameSchema, passwordSchema } from './validation.ts'

// Request bodies for /api/auth. The API parses with these; the forms validate with the same ones.

export const SignUpInput = z.object({
  name: nameSchema,
  email: emailSchema,
  password: passwordSchema,
  // Data Privacy Act (RA 10173): consent is recorded with the time it was given
  acceptedTerms: z.boolean().refine((v) => v, 'Agree to the Terms and Privacy Notice to continue.'),
})
export const SignInInput = z.object({
  email: emailSchema,
  password: existingPasswordSchema,
  remember: z.boolean().default(false),
})
export const EmailInput = z.object({ email: emailSchema })
export const ResetPasswordInput = z.object({ token: linkTokenSchema, password: passwordSchema })

export type SignUpInput = z.input<typeof SignUpInput>
export type SignInInput = z.input<typeof SignInInput>
export type EmailInput = z.input<typeof EmailInput>
export type ResetPasswordInput = z.input<typeof ResetPasswordInput>
