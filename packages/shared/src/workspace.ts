import { z } from 'zod'
import type { Permission } from './permissions.ts'
import { MODULE_SLUGS, TEMPLATE_KEYS, type ModuleSlug } from './templates.ts'

// A workspace is one business: its books, its TIN, its people.

export const VAT_STATUSES = ['vat', 'non_vat'] as const
export type VatStatus = (typeof VAT_STATUSES)[number]
export const VAT_STATUS_LABELS: Record<VatStatus, string> = { vat: 'VAT-registered', non_vat: 'Non-VAT (percentage tax)' }

/**
 * A TIN as 000-000-000-00000: nine digits, then the branch code (000 or 00000 for the head office).
 * Typed with or without dashes; stored formatted.
 */
export const tinSchema = z
  .string()
  .trim()
  .transform((v) => v.replace(/[\s-]/g, ''))
  .refine((v) => /^\d{12,14}$/.test(v), 'Enter the TIN as 000-000-000-00000 (9 digits and the branch code).')
  .transform((v) => `${v.slice(0, 3)}-${v.slice(3, 6)}-${v.slice(6, 9)}-${v.slice(9)}`)

/** An optional TIN: blank is fine (a walk-in customer, a supplier without one on file). */
export const optionalTinSchema = z
  .string()
  .trim()
  .transform((v) => (v === '' ? undefined : v))
  .pipe(tinSchema.optional())

const text = (label: string, max: number) =>
  z
    .string(`Enter the ${label}.`)
    .trim()
    .min(1, `Enter the ${label}.`)
    .max(max, `Use ${max} characters or fewer.`)
    .refine((v) => !/[\p{Cc}]/u.test(v.replace(/\n/g, '')), 'Leave out invisible characters.')

/** A PSGC barangay code: nine digits. */
const psgcCode = z.string().regex(/^\d{9}$/, 'Choose a barangay from the list.')

const blankToNull = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? null : v)

/**
 * The business's address. With a barangay picked from the PSGC list, `street` is just the house,
 * street and building, and the API writes out the rest from the official names. Without one (the
 * list isn't loaded), `street` is the whole address.
 */
const addressFields = {
  street: text('address', 300),
  barangayCode: z.preprocess(blankToNull, psgcCode.nullable()).default(null),
}

const dpoFields = {
  /** Data Privacy Act: the person who answers for personal data in this business. */
  dpoName: z.preprocess(blankToNull, z.string().trim().max(120).nullable()).default(null),
  dpoEmail: z.preprocess(blankToNull, z.email('Enter a valid email address.').nullable()).default(null),
}

export const WorkspaceInput = z.object({
  template: z.enum(TEMPLATE_KEYS, 'Choose the kind of business.'),
  name: text('business name', 120),
  tin: tinSchema,
  vatStatus: z.enum(VAT_STATUSES, 'Choose VAT-registered or non-VAT.'),
  ...addressFields,
  fiscalYearStartMonth: z.coerce.number().int().min(1).max(12).default(1),
})
export type WorkspaceInput = z.input<typeof WorkspaceInput>

export const WorkspaceUpdate = z.object({
  name: text('business name', 120),
  tin: tinSchema,
  vatStatus: z.enum(VAT_STATUSES),
  ...addressFields,
  fiscalYearStartMonth: z.coerce.number().int().min(1).max(12),
  ...dpoFields,
  modules: z.array(z.enum(MODULE_SLUGS)).refine((m) => m.includes('finance'), 'Finance is always on.'),
})
export type WorkspaceUpdate = z.input<typeof WorkspaceUpdate>

export type WorkspaceSummary = { id: string; name: string; roleName: string }

export type Workspace = {
  id: string
  name: string
  tin: string
  vatStatus: VatStatus
  /** The full address as it prints on invoices and BIR forms. */
  registeredAddress: string
  street: string
  barangayCode: string | null
  fiscalYearStartMonth: number
  template: string
  modules: ModuleSlug[]
  dpoName: string | null
  dpoEmail: string | null
  /** The signed-in person's role here, and what it lets them do. */
  role: { id: string; key: string | null; name: string }
  permissions: Permission[]
}

/* ---------------------------------------------------------------------------------------------
 * Joining: one-time codes
 * ------------------------------------------------------------------------------------------- */

/** The letters a code is made of: no 0/O or 1/I/L, so it can be read out loud without mistakes. */
export const JOIN_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

/** "7k3q 9xpa", "7K3Q-9XPA" → "7K3Q9XPA". */
export const normalizeJoinCode = (v: string) => v.toUpperCase().replace(/[\s-]/g, '')

export const JoinInput = z.object({
  code: z
    .string('Enter the code.')
    .transform(normalizeJoinCode)
    .refine((v) => v.length === 8 && [...v].every((c) => JOIN_CODE_ALPHABET.includes(c)), 'A code is 8 letters and numbers, like 7K3Q-9XPA.'),
})

export const JOIN_CODE_LIFETIMES = { '1h': 'For 1 hour', '24h': 'For 24 hours', '7d': 'For 7 days' } as const
export type JoinCodeLifetime = keyof typeof JOIN_CODE_LIFETIMES

export const JoinCodeInput = z.object({
  roleId: z.uuid('Choose the role the code gives.'),
  expiresIn: z.enum(Object.keys(JOIN_CODE_LIFETIMES) as [JoinCodeLifetime, ...JoinCodeLifetime[]]).default('24h'),
})

export type JoinCode = {
  id: string
  role: { id: string; name: string }
  createdBy: string | null
  createdAt: string
  expiresAt: string
  status: 'active' | 'used' | 'expired' | 'revoked'
  usedBy: string | null
  usedAt: string | null
}

/** Only in the answer to creating a code: the code itself is never shown again. */
export type NewJoinCode = JoinCode & { code: string }

/* ---------------------------------------------------------------------------------------------
 * Members and the audit log
 * ------------------------------------------------------------------------------------------- */

export const MemberUpdate = z.object({ roleId: z.uuid('Choose a role.') })

export type Member = {
  userId: string
  name: string
  email: string
  role: { id: string; key: string | null; name: string }
  joinedAt: string
  isYou: boolean
}

export type AuditEntry = {
  id: string
  at: string
  actor: { id: string; name: string } | null
  action: string
  entity: string
  entityId: string | null
  summary: string
  before: unknown
  after: unknown
}

/* ---------------------------------------------------------------------------------------------
 * Philippine places (PSGC)
 * ------------------------------------------------------------------------------------------- */

export type PsgcPlace = { code: string; name: string }

/** A barangay with everything above it, for showing a chosen address back. */
export type PsgcAddress = { barangay: PsgcPlace; city: PsgcPlace; province: PsgcPlace | null; region: PsgcPlace }

export { text as textField }
