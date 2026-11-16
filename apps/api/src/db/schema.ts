import { sql } from 'drizzle-orm'
import { bigint, boolean, check, date, doublePrecision, index, integer, jsonb, numeric, pgEnum, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid, type AnyPgColumn } from 'drizzle-orm/pg-core'

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

/**
 * "Try the demo" accounts (features/demo). A spare is built ahead of time so a visitor doesn't wait;
 * claiming it gives it an expiry, and the nightly job deletes the account with its workspace. The
 * password (for signing the same demo in on the phone) is kept encrypted: it's shown back to the
 * visitor, and a demo account holds nothing worth protecting beyond that.
 */
export const demoAccounts = pgTable('demo_accounts', {
  userId: uuid()
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  workspaceId: uuid().notNull(),
  passwordEnc: text(),
  /** Set when the build finished. A build cut short (the server restarted) is never handed out. */
  ready: boolean().notNull().default(false),
  claimedAt: timestamp({ withTimezone: true }),
  expiresAt: timestamp({ withTimezone: true }),
  createdAt: createdAt(),
})

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
  /** Licences and permits the template asks for (FDA LTO, PCAB…): key → text. */
  licences: jsonb().$type<Record<string, string>>().notNull().default({}),
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
    /** Customers (Phase 4): days to pay, and the most they may owe in centavos (null: no limit). */
    paymentTermsDays: integer(),
    creditLimit: bigint({ mode: 'number' }),
    /** Phase 8: the price list their prices come from. */
    priceListId: uuid().references((): AnyPgColumn => priceLists.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('contacts_workspace_idx').on(t.workspaceId, t.name)],
)

export const journalSource = pgEnum('journal_source', ['manual', 'sales_invoice', 'bill', 'payment_received', 'payment_made', 'reversal', 'stock_adjustment', 'goods_receipt', 'delivery', 'payroll', 'payroll_payment', 'production', 'project'])
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
    /** Where stock items on this invoice leave from (Phase 3). */
    warehouseId: uuid().references((): AnyPgColumn => warehouses.id),
    date: date().notNull(),
    dueDate: date(),
    pricesIncludeVat: boolean().notNull().default(false),
    notes: text(),
    ...documentTotals(),
    journalEntryId: uuid().references(() => journalEntries.id),
    /** Phase 7: the project it bills, or is a cost of. */
    projectId: uuid().references((): AnyPgColumn => projects.id, { onDelete: 'set null' }),
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
    /** Phase 7: the project it bills, or is a cost of. */
    projectId: uuid().references((): AnyPgColumn => projects.id, { onDelete: 'set null' }),
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
    /** The item sold or bought, when the line is for one (Phase 3). */
    itemId: uuid().references((): AnyPgColumn => items.id),
    /** On a bill made from a purchase order: the PO line it pays for. */
    poLineId: uuid().references((): AnyPgColumn => purchaseOrderLines.id),
    /** On an invoice made from a sales order: the order line it bills (Phase 4). */
    soLineId: uuid().references((): AnyPgColumn => salesLines.id),
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

/* =============================================================================================
 * Phones (Phase 1M)
 * =========================================================================================== */

/**
 * Where to send push notifications: one Expo push token per installed phone app. A token belongs
 * to whoever signed in on that phone last, and is dropped when they sign out there or Expo says
 * the app was uninstalled.
 */
export const pushTokens = pgTable(
  'push_tokens',
  {
    token: text().primaryKey(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    platform: text().notNull(),
    createdAt: createdAt(),
    lastSeenAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('push_tokens_user_idx').on(t.userId)],
)

/* =============================================================================================
 * Inventory and purchasing (Phase 3)
 * =========================================================================================== */

const qty = () => numeric({ precision: 18, scale: 4, mode: 'number' }).notNull().default(0)

export const units = pgTable(
  'units',
  { id: id(), workspaceId: workspaceId(), code: text().notNull(), name: text().notNull() },
  (t) => [uniqueIndex('units_code_key').on(t.workspaceId, t.code)],
)

export const warehouses = pgTable(
  'warehouses',
  { id: id(), workspaceId: workspaceId(), code: text().notNull(), name: text().notNull(), address: text(), active: boolean().notNull().default(true), createdAt: createdAt() },
  (t) => [uniqueIndex('warehouses_code_key').on(t.workspaceId, t.code)],
)

export const itemKind = pgEnum('item_kind', ['stock', 'service'])

export const items = pgTable(
  'items',
  {
    id: id(),
    workspaceId: workspaceId(),
    sku: text().notNull(),
    name: text().notNull(),
    description: text(),
    kind: itemKind().notNull().default('stock'),
    barcode: text(),
    unitId: uuid()
      .notNull()
      .references(() => units.id),
    /** Centavos per unit. */
    salesPrice: money(),
    purchaseCost: money(),
    salesVat: vatTreatment().notNull().default('vatable'),
    trackLots: boolean().notNull().default(false),
    trackExpiry: boolean().notNull().default(false),
    reorderPoint: qty(),
    reorderQty: qty(),
    /** Overrides: where its sales go (default Sales), and where a non-stock item's purchases go. */
    salesAccountId: uuid().references(() => accounts.id),
    expenseAccountId: uuid().references(() => accounts.id),
    active: boolean().notNull().default(true),
    /** The template's extra fields (FDA registration, hazard class…): key → text. */
    attributes: jsonb().$type<Record<string, string>>().notNull().default({}),
    /** A size × colour variant: the style item it was made from. */
    parentId: uuid().references((): AnyPgColumn => items.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('items_sku_key').on(t.workspaceId, t.sku),
    uniqueIndex('items_barcode_key').on(t.workspaceId, t.barcode).where(sql`${t.barcode} is not null`),
    index('items_name_idx').on(t.workspaceId, t.name),
  ],
)

export const stockLots = pgTable(
  'stock_lots',
  {
    id: id(),
    workspaceId: workspaceId(),
    itemId: uuid()
      .notNull()
      .references(() => items.id),
    lotNo: text().notNull(),
    expiryDate: date(),
    /** released, quarantine (waiting for QC, not sold or used) or rejected. */
    status: text().notNull().default('released'),
    decidedAt: timestamp({ withTimezone: true }),
    decidedBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('stock_lots_key').on(t.itemId, t.lotNo)],
)

export const stockDocumentKind = pgEnum('stock_document_kind', ['adjustment', 'transfer', 'receipt', 'delivery'])
export const stockDocumentStatus = pgEnum('stock_document_status', ['posted', 'void'])

/** Adjustments (ADJ-), transfers (TR-), goods receipts (GR-) and deliveries (DR-): what makes stock moves. */
export const stockDocuments = pgTable(
  'stock_documents',
  {
    id: id(),
    workspaceId: workspaceId(),
    kind: stockDocumentKind().notNull(),
    number: text().notNull(),
    status: stockDocumentStatus().notNull().default('posted'),
    date: date().notNull(),
    warehouseId: uuid()
      .notNull()
      .references(() => warehouses.id),
    /** Transfers: where the stock went. */
    toWarehouseId: uuid().references(() => warehouses.id),
    /** Adjustments: count, damage, expired, opening, other. */
    reason: text(),
    /** Receipts: the purchase order received against. */
    poId: uuid().references((): AnyPgColumn => purchaseOrders.id),
    /** Deliveries: the sales order delivered against. */
    soId: uuid().references((): AnyPgColumn => salesOrders.id),
    notes: text(),
    journalEntryId: uuid().references(() => journalEntries.id),
    createdBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('stock_documents_number_key').on(t.workspaceId, t.number), index('stock_documents_date_idx').on(t.workspaceId, t.date)],
)

export const moveKind = pgEnum('move_kind', ['receipt', 'issue', 'adjustment', 'transfer', 'return', 'consume', 'produce'])

/**
 * The stock ledger. On hand is the sum of quantities; value the sum of values. Rows are never
 * changed or deleted (a trigger refuses it): corrections are new moves, as in the books.
 */
export const stockMoves = pgTable(
  'stock_moves',
  {
    id: id(),
    workspaceId: workspaceId(),
    itemId: uuid()
      .notNull()
      .references(() => items.id),
    warehouseId: uuid()
      .notNull()
      .references(() => warehouses.id),
    lotId: uuid().references(() => stockLots.id),
    date: date().notNull(),
    kind: moveKind().notNull(),
    /** + in, − out. */
    quantity: numeric({ precision: 18, scale: 4, mode: 'number' }).notNull(),
    /** Centavos, + in, − out, at moving average cost. */
    value: bigint({ mode: 'number' }).notNull(),
    documentId: uuid().references(() => stockDocuments.id),
    invoiceId: uuid().references(() => salesInvoices.id),
    poLineId: uuid().references((): AnyPgColumn => purchaseOrderLines.id),
    soLineId: uuid().references((): AnyPgColumn => salesLines.id),
    /** Manufacturing: materials used by a work order, or what it produced. */
    workOrderId: uuid().references((): AnyPgColumn => workOrders.id),
    /** Projects: materials taken for a project. */
    projectId: uuid().references((): AnyPgColumn => projects.id),
    createdAt: createdAt(),
  },
  (t) => [
    index('stock_moves_wo_idx').on(t.workOrderId),
    index('stock_moves_item_idx').on(t.workspaceId, t.itemId, t.warehouseId),
    index('stock_moves_document_idx').on(t.documentId),
    index('stock_moves_invoice_idx').on(t.invoiceId),
  ],
)

export const poStatus = pgEnum('po_status', ['draft', 'issued', 'partly_received', 'received', 'closed', 'cancelled'])

export const purchaseOrders = pgTable(
  'purchase_orders',
  {
    id: id(),
    workspaceId: workspaceId(),
    number: text(),
    status: poStatus().notNull().default('draft'),
    supplierId: uuid()
      .notNull()
      .references(() => contacts.id),
    date: date().notNull(),
    expectedDate: date(),
    warehouseId: uuid()
      .notNull()
      .references(() => warehouses.id),
    pricesIncludeVat: boolean().notNull().default(false),
    notes: text(),
    ...documentTotals(),
    /** Closed by someone, not by everything arriving and being billed: stays closed whatever happens later. */
    closedByHand: boolean().notNull().default(false),
    issuedAt: timestamp({ withTimezone: true }),
    createdBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('purchase_orders_number_key').on(t.workspaceId, t.number), index('purchase_orders_date_idx').on(t.workspaceId, t.date)],
)

export const purchaseOrderLines = pgTable(
  'purchase_order_lines',
  {
    id: id(),
    workspaceId: workspaceId(),
    poId: uuid()
      .notNull()
      .references(() => purchaseOrders.id, { onDelete: 'cascade' }),
    position: integer().notNull(),
    itemId: uuid()
      .notNull()
      .references(() => items.id),
    description: text().notNull(),
    quantity: numeric({ precision: 18, scale: 4, mode: 'number' }).notNull(),
    unitCost: money(),
    vat: vatTreatment().notNull(),
    vatRateBp: integer().notNull(),
    ewtCodeId: uuid().references(() => taxCodes.id),
    ewtRateBp: integer(),
    gross: money(),
    net: money(),
    vatAmount: money(),
    ewtAmount: money(),
    receivedQty: qty(),
    billedQty: qty(),
  },
  (t) => [index('purchase_order_lines_po_idx').on(t.poId)],
)

/* =============================================================================================
 * Sales & CRM (Phase 4)
 * =========================================================================================== */

export const leadStage = pgEnum('lead_stage', ['new', 'qualified', 'proposal', 'negotiation', 'won', 'lost'])

/** A possible sale, from first contact to won or lost. */
export const leads = pgTable(
  'leads',
  {
    id: id(),
    workspaceId: workspaceId(),
    title: text().notNull(),
    companyName: text(),
    personName: text(),
    email: text(),
    phone: text(),
    /** referral, walk_in, website, social, event, cold_call, other */
    source: text().notNull().default('other'),
    stage: leadStage().notNull().default('new'),
    /** What the deal could be worth, in centavos. */
    value: money(),
    expectedClose: date(),
    ownerId: uuid().references(() => users.id, { onDelete: 'set null' }),
    /** The customer it is (or became, when converted). */
    customerId: uuid().references(() => contacts.id, { onDelete: 'set null' }),
    notes: text(),
    lostReason: text(),
    /** When it was won or lost. */
    closedAt: timestamp({ withTimezone: true }),
    createdBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('leads_workspace_idx').on(t.workspaceId, t.stage), index('leads_customer_idx').on(t.customerId)],
)

export const activityKind = pgEnum('activity_kind', ['note', 'call', 'meeting', 'email'])

/** Calls, meetings, emails and notes, on a lead, a customer, or both. */
export const crmActivities = pgTable(
  'crm_activities',
  {
    id: id(),
    workspaceId: workspaceId(),
    leadId: uuid().references(() => leads.id, { onDelete: 'cascade' }),
    contactId: uuid().references(() => contacts.id, { onDelete: 'cascade' }),
    kind: activityKind().notNull(),
    body: text().notNull(),
    date: date().notNull(),
    createdBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [
    index('crm_activities_lead_idx').on(t.leadId),
    index('crm_activities_contact_idx').on(t.contactId),
    check('crm_activities_has_subject', sql`${t.leadId} is not null or ${t.contactId} is not null`),
  ],
)

export const quoteStatus = pgEnum('quote_status', ['draft', 'sent', 'accepted', 'declined'])

export const quotes = pgTable(
  'quotes',
  {
    id: id(),
    workspaceId: workspaceId(),
    /** QT-000001, given when it's sent. */
    number: text(),
    status: quoteStatus().notNull().default('draft'),
    customerId: uuid()
      .notNull()
      .references(() => contacts.id),
    leadId: uuid().references(() => leads.id, { onDelete: 'set null' }),
    date: date().notNull(),
    validUntil: date(),
    pricesIncludeVat: boolean().notNull().default(false),
    notes: text(),
    ...documentTotals(),
    sentAt: timestamp({ withTimezone: true }),
    respondedAt: timestamp({ withTimezone: true }),
    createdBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('quotes_number_key').on(t.workspaceId, t.number), index('quotes_date_idx').on(t.workspaceId, t.date), index('quotes_customer_idx').on(t.customerId)],
)

export const soStatus = pgEnum('so_status', ['draft', 'confirmed', 'partly_delivered', 'delivered', 'closed', 'cancelled'])

export const salesOrders = pgTable(
  'sales_orders',
  {
    id: id(),
    workspaceId: workspaceId(),
    /** SO-000001, given when it's confirmed. */
    number: text(),
    status: soStatus().notNull().default('draft'),
    customerId: uuid()
      .notNull()
      .references(() => contacts.id),
    quoteId: uuid().references(() => quotes.id, { onDelete: 'set null' }),
    date: date().notNull(),
    deliveryDate: date(),
    /** Where its goods ship from; a delivery may still choose another. */
    warehouseId: uuid().references(() => warehouses.id),
    customerPoNo: text(),
    pricesIncludeVat: boolean().notNull().default(false),
    notes: text(),
    ...documentTotals(),
    /** Closed by someone, not by everything going out and being invoiced: stays closed whatever happens later. */
    closedByHand: boolean().notNull().default(false),
    confirmedAt: timestamp({ withTimezone: true }),
    createdBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('sales_orders_number_key').on(t.workspaceId, t.number), index('sales_orders_date_idx').on(t.workspaceId, t.date), index('sales_orders_customer_idx').on(t.customerId)],
)

/** Lines of both quotes and sales orders. Exactly one of quoteId and orderId is set. */
export const salesLines = pgTable(
  'sales_lines',
  {
    id: id(),
    workspaceId: workspaceId(),
    quoteId: uuid().references(() => quotes.id, { onDelete: 'cascade' }),
    orderId: uuid().references(() => salesOrders.id, { onDelete: 'cascade' }),
    position: integer().notNull(),
    itemId: uuid()
      .notNull()
      .references(() => items.id),
    description: text().notNull(),
    quantity: numeric({ precision: 18, scale: 4, mode: 'number' }).notNull(),
    unitPrice: money(),
    vat: vatTreatment().notNull(),
    vatRateBp: integer().notNull(),
    gross: money(),
    net: money(),
    vatAmount: money(),
    deliveredQty: qty(),
    invoicedQty: qty(),
  },
  (t) => [
    index('sales_lines_quote_idx').on(t.quoteId),
    index('sales_lines_order_idx').on(t.orderId),
    check('sales_lines_one_parent', sql`(${t.quoteId} is null) <> (${t.orderId} is null)`),
  ],
)

/* =============================================================================================
 * HR & payroll (Phase 5)
 * =========================================================================================== */

/**
 * People on the payroll. Government ID numbers are stored encrypted (lib/crypto.ts), as the Data
 * Privacy Act expects; `userId` links the member who signs in as them, for self-service.
 */
export const employees = pgTable(
  'employees',
  {
    id: id(),
    workspaceId: workspaceId(),
    employeeNo: text().notNull(),
    userId: uuid().references(() => users.id, { onDelete: 'set null' }),
    firstName: text().notNull(),
    middleName: text(),
    lastName: text().notNull(),
    birthDate: date(),
    email: text(),
    phone: text(),
    address: text(),
    position: text().notNull(),
    department: text(),
    employmentType: text().notNull().default('regular'),
    hireDate: date().notNull(),
    separationDate: date(),
    tinEnc: text(),
    sssNoEnc: text(),
    philhealthNoEnc: text(),
    pagibigNoEnc: text(),
    /** monthly or daily; `rate` is the monthly salary or the daily rate, in centavos. */
    payBasis: text().notNull().default('monthly'),
    rate: money(),
    payFrequency: text().notNull().default('semi_monthly'),
    workDaysPerYear: integer().notNull().default(261),
    minimumWageEarner: boolean().notNull().default(false),
    tracksAttendance: boolean().notNull().default(true),
    shiftStart: text().notNull().default('08:00'),
    restDays: integer().array().notNull().default(sql`ARRAY[0]::integer[]`),
    workRegionCode: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('employees_number_key').on(t.workspaceId, t.employeeNo),
    uniqueIndex('employees_user_key').on(t.workspaceId, t.userId).where(sql`${t.userId} is not null`),
    index('employees_name_idx').on(t.workspaceId, t.lastName),
  ],
)

/** Clock-ins and clock-outs, from the phone (with where), the web, or entered by HR. */
export const timeEntries = pgTable(
  'time_entries',
  {
    id: id(),
    workspaceId: workspaceId(),
    employeeId: uuid()
      .notNull()
      .references(() => employees.id, { onDelete: 'cascade' }),
    clockIn: timestamp({ withTimezone: true }).notNull(),
    clockOut: timestamp({ withTimezone: true }),
    inLatitude: doublePrecision(),
    inLongitude: doublePrecision(),
    inAccuracy: doublePrecision(),
    outLatitude: doublePrecision(),
    outLongitude: doublePrecision(),
    outAccuracy: doublePrecision(),
    /** phone, web or manual */
    source: text().notNull(),
    note: text(),
    createdBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('time_entries_employee_idx').on(t.employeeId, t.clockIn),
    index('time_entries_workspace_idx').on(t.workspaceId, t.clockIn),
    // one open entry per person: clocking in twice is refused by the database too
    uniqueIndex('time_entries_one_open').on(t.employeeId).where(sql`${t.clockOut} is null`),
  ],
)

export const holidays = pgTable(
  'holidays',
  { id: id(), workspaceId: workspaceId(), date: date().notNull(), name: text().notNull(), /** regular or special */ kind: text().notNull() },
  (t) => [uniqueIndex('holidays_date_key').on(t.workspaceId, t.date)],
)

export const leaveTypes = pgTable(
  'leave_types',
  {
    id: id(),
    workspaceId: workspaceId(),
    code: text().notNull(),
    name: text().notNull(),
    paid: boolean().notNull(),
    /** Days a year; null means no limit. */
    daysPerYear: numeric({ precision: 6, scale: 1, mode: 'number' }),
    active: boolean().notNull().default(true),
  },
  (t) => [uniqueIndex('leave_types_code_key').on(t.workspaceId, t.code)],
)

export const leaveStatus = pgEnum('leave_status', ['pending', 'approved', 'rejected', 'cancelled'])

export const leaveRequests = pgTable(
  'leave_requests',
  {
    id: id(),
    workspaceId: workspaceId(),
    employeeId: uuid()
      .notNull()
      .references(() => employees.id, { onDelete: 'cascade' }),
    leaveTypeId: uuid()
      .notNull()
      .references(() => leaveTypes.id),
    startDate: date().notNull(),
    endDate: date().notNull(),
    halfDay: boolean().notNull().default(false),
    days: numeric({ precision: 6, scale: 1, mode: 'number' }).notNull(),
    reason: text(),
    status: leaveStatus().notNull().default('pending'),
    decidedBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    decidedAt: timestamp({ withTimezone: true }),
    decisionNote: text(),
    createdBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [index('leave_requests_employee_idx').on(t.employeeId, t.startDate), index('leave_requests_workspace_idx').on(t.workspaceId, t.status)],
)

/**
 * Government rates, the same for every workspace: SSS, PhilHealth, Pag-IBIG, withholding tax,
 * premium pay, 13th month and minimum wages, each with the date it applies from. A new circular is
 * a new row; payroll uses the newest row on or before the period it pays.
 */
export const govRates = pgTable(
  'gov_rates',
  { id: id(), kind: text().notNull(), effectiveFrom: date().notNull(), data: jsonb().notNull(), source: text().notNull(), createdAt: createdAt() },
  (t) => [uniqueIndex('gov_rates_key').on(t.kind, t.effectiveFrom)],
)

export const runStatus = pgEnum('run_status', ['draft', 'posted', 'paid'])

export const payrollRuns = pgTable(
  'payroll_runs',
  {
    id: id(),
    workspaceId: workspaceId(),
    /** PR-000001, given when posted. */
    number: text(),
    /** regular or thirteenth */
    kind: text().notNull(),
    frequency: text().notNull(),
    periodStart: date().notNull(),
    periodEnd: date().notNull(),
    payDate: date().notNull(),
    status: runStatus().notNull().default('draft'),
    takesContributions: boolean().notNull(),
    journalEntryId: uuid().references(() => journalEntries.id),
    paymentEntryId: uuid().references(() => journalEntries.id),
    postedAt: timestamp({ withTimezone: true }),
    createdBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('payroll_runs_number_key').on(t.workspaceId, t.number), index('payroll_runs_period_idx').on(t.workspaceId, t.periodEnd)],
)

/** One employee's pay in a run. The figures are kept as computed, so reports never redo history. */
export const payrollLines = pgTable(
  'payroll_lines',
  {
    id: id(),
    workspaceId: workspaceId(),
    runId: uuid()
      .notNull()
      .references(() => payrollRuns.id, { onDelete: 'cascade' }),
    employeeId: uuid()
      .notNull()
      .references(() => employees.id),
    payBasis: text().notNull(),
    dailyRate: money(),
    minimumWageEarner: boolean().notNull(),
    inputs: jsonb().notNull(),
    edited: boolean().notNull().default(false),
    result: jsonb().notNull(),
    basic: money(),
    gross: money(),
    grossTaxable: money(),
    nonTaxable: money(),
    taxable: money(),
    sssMsc: money(),
    sssEe: money(),
    sssEr: money(),
    sssEc: money(),
    philhealthBase: money(),
    philhealthEe: money(),
    philhealthEr: money(),
    pagibigBase: money(),
    pagibigEe: money(),
    pagibigEr: money(),
    tax: money(),
    otherDeductions: money(),
    net: money(),
  },
  (t) => [uniqueIndex('payroll_lines_employee_key').on(t.runId, t.employeeId), index('payroll_lines_employee_idx').on(t.employeeId)],
)

/* =============================================================================================
 * Manufacturing (Phase 6)
 * =========================================================================================== */

/** Where work is done, and what an hour there costs (labour and overhead). */
export const workCenters = pgTable(
  'work_centers',
  { id: id(), workspaceId: workspaceId(), code: text().notNull(), name: text().notNull(), costPerHour: money(), active: boolean().notNull().default(true), createdAt: createdAt() },
  (t) => [uniqueIndex('work_centers_code_key').on(t.workspaceId, t.code)],
)

/** A bill of materials: what one batch of a product takes. One active per product. */
export const boms = pgTable(
  'boms',
  {
    id: id(),
    workspaceId: workspaceId(),
    itemId: uuid()
      .notNull()
      .references(() => items.id),
    version: integer().notNull(),
    outputQty: qty(),
    active: boolean().notNull().default(true),
    notes: text(),
    qcChecks: text().array().notNull().default(sql`ARRAY[]::text[]`),
    createdBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('boms_version_key').on(t.itemId, t.version), uniqueIndex('boms_one_active').on(t.itemId).where(sql`${t.active}`)],
)

export const bomLines = pgTable(
  'bom_lines',
  {
    id: id(),
    workspaceId: workspaceId(),
    bomId: uuid()
      .notNull()
      .references(() => boms.id, { onDelete: 'cascade' }),
    position: integer().notNull(),
    itemId: uuid()
      .notNull()
      .references(() => items.id),
    quantity: qty(),
    notes: text(),
  },
  (t) => [index('bom_lines_bom_idx').on(t.bomId), index('bom_lines_item_idx').on(t.itemId)],
)

/** The routing: the steps, in order, each at a work centre. */
export const bomOperations = pgTable(
  'bom_operations',
  {
    id: id(),
    workspaceId: workspaceId(),
    bomId: uuid()
      .notNull()
      .references(() => boms.id, { onDelete: 'cascade' }),
    position: integer().notNull(),
    workCenterId: uuid()
      .notNull()
      .references(() => workCenters.id),
    description: text().notNull(),
    /** Per batch. */
    minutes: numeric({ precision: 10, scale: 2, mode: 'number' }).notNull(),
  },
  (t) => [index('bom_operations_bom_idx').on(t.bomId)],
)

export const woStatus = pgEnum('wo_status', ['draft', 'released', 'in_progress', 'completed', 'cancelled'])

/**
 * A work order. Materials and operations are copied from the BOM when it's made, so changing the BOM
 * later doesn't rewrite history. Once completed it can't be changed (a trigger, as for posted records).
 */
export const workOrders = pgTable(
  'work_orders',
  {
    id: id(),
    workspaceId: workspaceId(),
    number: text(),
    status: woStatus().notNull().default('draft'),
    bomId: uuid()
      .notNull()
      .references(() => boms.id),
    itemId: uuid()
      .notNull()
      .references(() => items.id),
    quantity: qty(),
    goodQty: qty(),
    rejectedQty: qty(),
    warehouseId: uuid()
      .notNull()
      .references(() => warehouses.id),
    startDate: date().notNull(),
    dueDate: date().notNull(),
    salesOrderId: uuid().references(() => salesOrders.id),
    notes: text(),
    qcChecks: text().array().notNull().default(sql`ARRAY[]::text[]`),
    qc: jsonb().notNull().default(sql`'[]'::jsonb`),
    lotId: uuid().references(() => stockLots.id),
    materialCost: money(),
    conversionCost: money(),
    startedAt: timestamp({ withTimezone: true }),
    completedAt: timestamp({ withTimezone: true }),
    createdBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('work_orders_number_key').on(t.workspaceId, t.number), index('work_orders_status_idx').on(t.workspaceId, t.status, t.dueDate)],
)

export const woMaterials = pgTable(
  'wo_materials',
  {
    id: id(),
    workspaceId: workspaceId(),
    workOrderId: uuid()
      .notNull()
      .references(() => workOrders.id, { onDelete: 'cascade' }),
    position: integer().notNull(),
    itemId: uuid()
      .notNull()
      .references(() => items.id),
    plannedQty: qty(),
    issuedQty: qty(),
    issuedValue: money(),
  },
  (t) => [index('wo_materials_wo_idx').on(t.workOrderId)],
)

export const woOperations = pgTable(
  'wo_operations',
  {
    id: id(),
    workspaceId: workspaceId(),
    workOrderId: uuid()
      .notNull()
      .references(() => workOrders.id, { onDelete: 'cascade' }),
    position: integer().notNull(),
    workCenterId: uuid()
      .notNull()
      .references(() => workCenters.id),
    description: text().notNull(),
    plannedMinutes: numeric({ precision: 10, scale: 2, mode: 'number' }).notNull(),
    actualMinutes: numeric({ precision: 10, scale: 2, mode: 'number' }),
    /** The rate when it was done, so a later change of rate doesn't rewrite history. */
    costPerHour: money(),
    cost: money(),
  },
  (t) => [index('wo_operations_wo_idx').on(t.workOrderId)],
)

/* =============================================================================================
 * Projects (Phase 7)
 * =========================================================================================== */

export const projectStatus = pgEnum('project_status', ['planning', 'active', 'on_hold', 'completed', 'cancelled'])
export const billingMethod = pgEnum('billing_method', ['fixed', 'hourly', 'none'])
export const taskStatus = pgEnum('task_status', ['todo', 'in_progress', 'done'])

export const projects = pgTable(
  'projects',
  {
    id: id(),
    workspaceId: workspaceId(),
    number: text().notNull(),
    name: text().notNull(),
    customerId: uuid().references(() => contacts.id),
    managerId: uuid().references(() => users.id, { onDelete: 'set null' }),
    status: projectStatus().notNull().default('planning'),
    startDate: date().notNull(),
    endDate: date().notNull(),
    billing: billingMethod().notNull().default('fixed'),
    contractValue: money(),
    hourlyRate: money(),
    costBudget: money(),
    /** Basis points of each milestone held back until turnover. */
    retentionBp: integer().notNull().default(0),
    retentionInvoiceId: uuid().references(() => salesInvoices.id, { onDelete: 'set null' }),
    siteAddress: text(),
    description: text(),
    createdBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('projects_number_key').on(t.workspaceId, t.number), index('projects_status_idx').on(t.workspaceId, t.status)],
)

/** A milestone. Its state is worked out: invoiced when it has an invoice, done when it has a date. */
export const projectMilestones = pgTable(
  'project_milestones',
  {
    id: id(),
    workspaceId: workspaceId(),
    projectId: uuid()
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    dueDate: date().notNull(),
    amount: money(),
    doneAt: timestamp({ withTimezone: true }),
    invoiceId: uuid().references(() => salesInvoices.id, { onDelete: 'set null' }),
    /** What its invoice held back as retention (Phase 8), kept as billed. */
    retention: money(),
    createdAt: createdAt(),
  },
  (t) => [index('project_milestones_project_idx').on(t.projectId, t.dueDate)],
)

export const projectTasks = pgTable(
  'project_tasks',
  {
    id: id(),
    workspaceId: workspaceId(),
    projectId: uuid()
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    milestoneId: uuid().references(() => projectMilestones.id, { onDelete: 'set null' }),
    name: text().notNull(),
    description: text(),
    assigneeId: uuid().references(() => users.id, { onDelete: 'set null' }),
    startDate: date().notNull(),
    endDate: date().notNull(),
    estimatedHours: numeric({ precision: 10, scale: 2, mode: 'number' }).notNull().default(0),
    progress: integer().notNull().default(0),
    status: taskStatus().notNull().default('todo'),
    dependsOnId: uuid().references((): AnyPgColumn => projectTasks.id, { onDelete: 'set null' }),
    fieldWork: boolean().notNull().default(false),
    location: text(),
    notes: text(),
    doneAt: timestamp({ withTimezone: true }),
    doneLatitude: doublePrecision(),
    doneLongitude: doublePrecision(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('project_tasks_project_idx').on(t.projectId, t.startDate), index('project_tasks_assignee_idx').on(t.assigneeId, t.status)],
)

/**
 * Hours on a project. The cost per hour is the employee's daily rate ÷ 8 when it was logged, kept so
 * a raise later doesn't rewrite job costs. Billed hours point at their invoice (cleared if it's voided).
 */
export const timesheets = pgTable(
  'timesheets',
  {
    id: id(),
    workspaceId: workspaceId(),
    projectId: uuid()
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    taskId: uuid().references(() => projectTasks.id, { onDelete: 'set null' }),
    employeeId: uuid()
      .notNull()
      .references(() => employees.id, { onDelete: 'cascade' }),
    date: date().notNull(),
    hours: numeric({ precision: 6, scale: 2, mode: 'number' }).notNull(),
    billable: boolean().notNull().default(true),
    note: text(),
    costRate: money(),
    cost: money(),
    invoiceId: uuid().references(() => salesInvoices.id, { onDelete: 'set null' }),
    createdBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [index('timesheets_project_idx').on(t.projectId, t.date), index('timesheets_employee_idx').on(t.employeeId, t.date)],
)

/* =============================================================================================
 * Price lists (Phase 8)
 * =========================================================================================== */

export const priceLists = pgTable(
  'price_lists',
  { id: id(), workspaceId: workspaceId(), name: text().notNull(), notes: text(), active: boolean().notNull().default(true), createdAt: createdAt(), updatedAt: updatedAt() },
  (t) => [uniqueIndex('price_lists_name_key').on(t.workspaceId, t.name)],
)

/** A price for an item from a quantity up: the line with the highest minimum the order reaches wins. */
export const priceListLines = pgTable(
  'price_list_lines',
  {
    id: id(),
    workspaceId: workspaceId(),
    priceListId: uuid()
      .notNull()
      .references(() => priceLists.id, { onDelete: 'cascade' }),
    itemId: uuid()
      .notNull()
      .references(() => items.id, { onDelete: 'cascade' }),
    minQty: numeric({ precision: 18, scale: 4, mode: 'number' }).notNull().default(0),
    price: money(),
  },
  (t) => [uniqueIndex('price_list_lines_key').on(t.priceListId, t.itemId, t.minQty)],
)
