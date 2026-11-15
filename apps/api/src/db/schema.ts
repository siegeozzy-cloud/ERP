import { sql } from 'drizzle-orm'
import { bigint, boolean, check, date, index, integer, jsonb, numeric, pgEnum, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid, type AnyPgColumn } from 'drizzle-orm/pg-core'

// Column names are snake_case in the database (drizzle `casing`), camelCase here.
// Money is whole centavos in bigint columns (read as JS numbers: safe up to ₱90 trillion).

const createdAt = () => timestamp({ withTimezone: true }).notNull().defaultNow()
const updatedAt = () => timestamp({ withTimezone: true }).notNull().defaultNow()
const id = () => uuid().primaryKey().defaultRandom()

export const users = pgTable(
  'users',
  {
    id: id(),
    /** Always stored lowercased. */
    email: text().notNull(),
    passwordHash: text().notNull(),
    name: text().notNull(),
    /** Sign-in is refused until the confirmation link has been opened. */
    emailVerifiedAt: timestamp({ withTimezone: true }),
    /** When the person agreed to the Terms and Privacy Notice (Data Privacy Act consent). */
    termsAcceptedAt: timestamp({ withTimezone: true }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('users_email_key').on(t.email)],
)

export type UserRow = typeof users.$inferSelect

/** Signed-in browsers and phones. The client holds a random token; only its SHA-256 is stored. */
export const sessions = pgTable(
  'sessions',
  {
    id: text().primaryKey(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    remember: boolean().notNull(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
)

export const emailTokenPurpose = pgEnum('email_token_purpose', ['verify', 'reset'])

/** Links sent by email (confirm address, reset password). Only the token's SHA-256 is stored. */
export const emailTokens = pgTable(
  'email_tokens',
  {
    id: text().primaryKey(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    purpose: emailTokenPurpose().notNull(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('email_tokens_user_idx').on(t.userId)],
)

/* =============================================================================================
 * Workspaces (slim core: Phase 1 adds roles, join codes, templates and the audit log)
 * =========================================================================================== */

export const vatStatus = pgEnum('vat_status', ['vat', 'non_vat'])

/** One business: its books, TIN and people. Everything below belongs to exactly one workspace. */
export const workspaces = pgTable('workspaces', {
  id: id(),
  name: text().notNull(),
  tin: text().notNull(),
  vatStatus: vatStatus().notNull(),
  /** The full address as it prints, written out from `street` and the PSGC names. */
  registeredAddress: text().notNull(),
  /** House, street and building (or the whole address when no barangay was picked). */
  street: text().notNull().default(''),
  /** PSGC codes, when the address was picked from the official list. */
  regionCode: text(),
  provinceCode: text(),
  cityCode: text(),
  barangayCode: text(),
  fiscalYearStartMonth: integer().notNull().default(1),
  /** Niche template it was created from (shared/templates.ts). */
  template: text().notNull().default('general'),
  /** Modules turned on. Finance is always among them. */
  modules: text().array().notNull().default(sql`ARRAY['finance','inventory','crm','hr']::text[]`),
  /** Data Privacy Act: the data protection officer. */
  dpoName: text(),
  dpoEmail: text(),
  createdBy: uuid().references(() => users.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

export type WorkspaceRow = typeof workspaces.$inferSelect

/** What members of a workspace may do. Owner (key 'owner') is fixed; the rest can be edited. */
export const roles = pgTable(
  'roles',
  {
    id: id(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** 'owner' or 'admin' for the built-in roles; null for the others. */
    key: text(),
    name: text().notNull(),
    description: text().notNull().default(''),
    permissions: text().array().notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('roles_name_key').on(t.workspaceId, t.name), uniqueIndex('roles_key_key').on(t.workspaceId, t.key)],
)

export type RoleRow = typeof roles.$inferSelect

export const memberships = pgTable(
  'memberships',
  {
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    roleId: uuid()
      .notNull()
      .references(() => roles.id),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.userId] }), index('memberships_user_idx').on(t.userId), index('memberships_role_idx').on(t.roleId)],
)

/**
 * One-time codes for joining a workspace. Only the code's SHA-256 is stored; the code itself is
 * shown once, to whoever made it. A code works once, until it expires or is revoked.
 */
export const joinCodes = pgTable(
  'join_codes',
  {
    id: id(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    codeHash: text().notNull(),
    roleId: uuid()
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    createdBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    usedBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    usedAt: timestamp({ withTimezone: true }),
    revokedAt: timestamp({ withTimezone: true }),
  },
  (t) => [uniqueIndex('join_codes_hash_key').on(t.codeHash), index('join_codes_workspace_idx').on(t.workspaceId, t.createdAt)],
)

/**
 * Who changed what, and when. Append-only: a database trigger refuses edits and deletes
 * (migration 0004), so the log can be trusted the way the books can.
 */
export const auditLog = pgTable(
  'audit_log',
  {
    id: id(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    actorId: uuid().references(() => users.id, { onDelete: 'set null' }),
    /** e.g. invoice.posted, member.role_changed */
    action: text().notNull(),
    entity: text().notNull(),
    entityId: text(),
    /** One sentence for people: "Posted sales invoice SI-000001 for ₱112,000.00". */
    summary: text().notNull(),
    before: jsonb(),
    after: jsonb(),
    ip: text(),
    createdAt: createdAt(),
  },
  (t) => [index('audit_log_workspace_idx').on(t.workspaceId, t.createdAt), index('audit_log_entity_idx').on(t.workspaceId, t.entity)],
)

/* =============================================================================================
 * Philippine Standard Geographic Code, loaded once by `npm run psgc:load -w @erp/api`
 * =========================================================================================== */

export const psgcRegions = pgTable('psgc_regions', {
  code: text().primaryKey(),
  name: text().notNull(),
  /** "Region I", "NCR", "BARMM". */
  shortName: text().notNull(),
})

export const psgcProvinces = pgTable(
  'psgc_provinces',
  { code: text().primaryKey(), name: text().notNull(), regionCode: text().notNull() },
  (t) => [index('psgc_provinces_region_idx').on(t.regionCode)],
)

/** Cities and municipalities. Metro Manila's, and a few independent cities, have no province. */
export const psgcCities = pgTable(
  'psgc_cities',
  { code: text().primaryKey(), name: text().notNull(), regionCode: text().notNull(), provinceCode: text(), isCity: boolean().notNull() },
  (t) => [index('psgc_cities_region_idx').on(t.regionCode), index('psgc_cities_province_idx').on(t.provinceCode)],
)

export const psgcBarangays = pgTable(
  'psgc_barangays',
  { code: text().primaryKey(), name: text().notNull(), cityCode: text().notNull() },
  (t) => [index('psgc_barangays_city_idx').on(t.cityCode)],
)

const workspaceId = () =>
  uuid()
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' })
const money = () => bigint({ mode: 'number' }).notNull().default(0)

/**
 * Document numbers, one counter per workspace and kind. Taken inside the posting transaction with
 * UPDATE … RETURNING, which locks the row: two postings can't get the same number, and a posting
 * that fails rolls its number back, so there are never gaps (EOPT expects unbroken serials).
 */
export const sequences = pgTable(
  'sequences',
  {
    workspaceId: workspaceId(),
    kind: text().notNull(),
    prefix: text().notNull(),
    next: integer().notNull().default(1),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.kind] })],
)

/* =============================================================================================
 * Finance (Phase 2)
 * =========================================================================================== */

export const accountType = pgEnum('account_type', ['asset', 'liability', 'equity', 'income', 'expense'])

export const accounts = pgTable(
  'accounts',
  {
    id: id(),
    workspaceId: workspaceId(),
    code: text().notNull(),
    name: text().notNull(),
    type: accountType().notNull(),
    /** cash, bank or other. */
    subtype: text().notNull().default('other'),
    /** Accounts the system posts to by itself: ar, ap, output_vat, input_vat, cwt, ewt_payable… */
    systemKey: text(),
    active: boolean().notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('accounts_code_key').on(t.workspaceId, t.code), uniqueIndex('accounts_system_key').on(t.workspaceId, t.systemKey)],
)

export const taxKind = pgEnum('tax_kind', ['vat', 'percentage', 'ewt'])

/** Tax rates as data, each with the date it applies from. */
export const taxCodes = pgTable(
  'tax_codes',
  {
    id: id(),
    workspaceId: workspaceId(),
    kind: taxKind().notNull(),
    code: text().notNull(),
    name: text().notNull(),
    /** Basis points: 1200 = 12%. */
    rateBp: integer().notNull(),
    atc: text(),
    effectiveFrom: date().notNull(),
    active: boolean().notNull().default(true),
  },
  (t) => [uniqueIndex('tax_codes_code_key').on(t.workspaceId, t.code, t.effectiveFrom)],
)

export const contacts = pgTable(
  'contacts',
  {
    id: id(),
    workspaceId: workspaceId(),
    name: text().notNull(),
    tin: text(),
    address: text(),
    email: text(),
    phone: text(),
    isCustomer: boolean().notNull().default(false),
    isSupplier: boolean().notNull().default(false),
    defaultEwtCodeId: uuid().references(() => taxCodes.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('contacts_workspace_idx').on(t.workspaceId, t.name)],
)

export const journalSource = pgEnum('journal_source', ['manual', 'sales_invoice', 'bill', 'payment_received', 'payment_made', 'reversal'])
export const journalStatus = pgEnum('journal_status', ['draft', 'posted'])

/**
 * The general journal. Every money movement in every module ends up here as a balanced entry.
 * Once posted, an entry and its lines can't be changed or deleted (a database trigger enforces it,
 * see migration 0002); mistakes are corrected with a reversing entry.
 */
export const journalEntries = pgTable(
  'journal_entries',
  {
    id: id(),
    workspaceId: workspaceId(),
    /** JE-000001, assigned when posted. */
    number: text(),
    status: journalStatus().notNull().default('draft'),
    date: date().notNull(),
    memo: text().notNull(),
    source: journalSource().notNull(),
    /** The invoice, bill or payment this entry was posted for. */
    sourceId: uuid(),
    reversesId: uuid().references((): AnyPgColumn => journalEntries.id),
    reversedById: uuid().references((): AnyPgColumn => journalEntries.id),
    postedAt: timestamp({ withTimezone: true }),
    createdBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('journal_entries_number_key').on(t.workspaceId, t.number),
    index('journal_entries_date_idx').on(t.workspaceId, t.date),
    index('journal_entries_source_idx').on(t.sourceId),
  ],
)

export const journalLines = pgTable(
  'journal_lines',
  {
    id: id(),
    entryId: uuid()
      .notNull()
      .references(() => journalEntries.id, { onDelete: 'cascade' }),
    workspaceId: workspaceId(),
    accountId: uuid()
      .notNull()
      .references(() => accounts.id),
    debit: money(),
    credit: money(),
    description: text(),
    contactId: uuid().references(() => contacts.id, { onDelete: 'set null' }),
    position: integer().notNull().default(0),
  },
  (t) => [
    index('journal_lines_entry_idx').on(t.entryId),
    index('journal_lines_account_idx').on(t.workspaceId, t.accountId),
    check('journal_lines_one_side', sql`(${t.debit} > 0 and ${t.credit} = 0) or (${t.credit} > 0 and ${t.debit} = 0)`),
  ],
)

export const documentStatus = pgEnum('document_status', ['draft', 'posted', 'void'])
export const vatTreatment = pgEnum('vat_treatment', ['vatable', 'zero_rated', 'exempt', 'none'])

/** Totals kept on the document, frozen at posting, so reports never recompute history with today's rates. */
const documentTotals = () => ({
  vatableAmount: money(),
  zeroRatedAmount: money(),
  exemptAmount: money(),
  nonVatAmount: money(),
  vatAmount: money(),
  total: money(),
  ewtAmount: money(),
  amountDue: money(),
})

export const salesInvoices = pgTable(
  'sales_invoices',
  {
    id: id(),
    workspaceId: workspaceId(),
    number: text(),
    status: documentStatus().notNull().default('draft'),
    customerId: uuid()
      .notNull()
      .references(() => contacts.id),
    date: date().notNull(),
    dueDate: date(),
    pricesIncludeVat: boolean().notNull().default(false),
    notes: text(),
    ...documentTotals(),
    journalEntryId: uuid().references(() => journalEntries.id),
    postedAt: timestamp({ withTimezone: true }),
    createdBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('sales_invoices_number_key').on(t.workspaceId, t.number), index('sales_invoices_date_idx').on(t.workspaceId, t.date)],
)

export const bills = pgTable(
  'bills',
  {
    id: id(),
    workspaceId: workspaceId(),
    number: text(),
    status: documentStatus().notNull().default('draft'),
    supplierId: uuid()
      .notNull()
      .references(() => contacts.id),
    supplierInvoiceNo: text(),
    date: date().notNull(),
    dueDate: date(),
    pricesIncludeVat: boolean().notNull().default(false),
    notes: text(),
    ...documentTotals(),
    journalEntryId: uuid().references(() => journalEntries.id),
    postedAt: timestamp({ withTimezone: true }),
    createdBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('bills_number_key').on(t.workspaceId, t.number), index('bills_date_idx').on(t.workspaceId, t.date)],
)

/** Lines of both invoices and bills. Exactly one of invoiceId and billId is set. */
export const documentLines = pgTable(
  'document_lines',
  {
    id: id(),
    workspaceId: workspaceId(),
    invoiceId: uuid().references(() => salesInvoices.id, { onDelete: 'cascade' }),
    billId: uuid().references(() => bills.id, { onDelete: 'cascade' }),
    position: integer().notNull(),
    description: text().notNull(),
    quantity: numeric({ precision: 18, scale: 4, mode: 'number' }).notNull(),
    unitPrice: money(),
    vat: vatTreatment().notNull(),
    vatRateBp: integer().notNull(),
    accountId: uuid()
      .notNull()
      .references(() => accounts.id),
    ewtCodeId: uuid().references(() => taxCodes.id),
    ewtRateBp: integer(),
    atc: text(),
    gross: money(),
    net: money(),
    vatAmount: money(),
    ewtAmount: money(),
  },
  (t) => [
    index('document_lines_invoice_idx').on(t.invoiceId),
    index('document_lines_bill_idx').on(t.billId),
    check('document_lines_one_parent', sql`(${t.invoiceId} is null) <> (${t.billId} is null)`),
  ],
)

export const paymentKind = pgEnum('payment_kind', ['received', 'made'])
export const paymentStatus = pgEnum('payment_status', ['posted', 'void'])

/** Money in against an invoice, or out against a bill. */
export const payments = pgTable(
  'payments',
  {
    id: id(),
    workspaceId: workspaceId(),
    number: text().notNull(),
    kind: paymentKind().notNull(),
    status: paymentStatus().notNull().default('posted'),
    invoiceId: uuid().references(() => salesInvoices.id),
    billId: uuid().references(() => bills.id),
    date: date().notNull(),
    accountId: uuid()
      .notNull()
      .references(() => accounts.id),
    amount: money(),
    /** Tax the customer withheld, for which they owe you a Form 2307. */
    withheld: money(),
    reference: text(),
    journalEntryId: uuid()
      .notNull()
      .references(() => journalEntries.id),
    createdBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('payments_number_key').on(t.workspaceId, t.number),
    index('payments_invoice_idx').on(t.invoiceId),
    index('payments_bill_idx').on(t.billId),
    check('payments_one_document', sql`(${t.invoiceId} is null) <> (${t.billId} is null)`),
  ],
)
