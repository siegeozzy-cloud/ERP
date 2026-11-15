# ERP — Product & Technical Plan

A multi-tenant ERP for Philippine businesses. People sign in, then either **join** a workspace with a
one-time code or **create** one from a template made for their kind of business. It runs on the web
and on phones.

**Status:** Phase 0 (foundations) is built. The phases are in [roadmap.md](roadmap.md).

**Scope:** a side project, built as a working showcase for investors. It runs on free tiers. It is
**not registered with the BIR** (it has no CAS permit), so every printed document is labelled
"Demo – not registered with the BIR".

---

## 1. Tech stack

Based on the stack of the sibling project `../Memoir`. Its login code (accounts, cookies, password
reset) gets ported over.

| Layer | Choice | Why |
|---|---|---|
| Repo | npm workspaces: `apps/web`, `apps/api`, `apps/mobile`, `packages/shared` | `shared` holds the Zod schemas, types and API client that web, API and mobile all use |
| Web | React + Vite + TypeScript | Same as Memoir |
| UI kit | shadcn/ui + Tailwind | An ERP has hundreds of forms and tables. Ready-made components save months |
| Data tables | TanStack Table | Sorting, filtering, grouping, column picking |
| Forms | React Hook Form + Zod | The same rules check input in the browser and on the server |
| Server data | TanStack Query | Caching and refetching |
| Routing | TanStack Router (or React Router) | |
| Charts | Recharts | |
| Phone app | **Expo (React Native) + TypeScript** | Reuses `packages/shared`. Flutter would mean writing every data model again in Dart |
| API | Fastify + Drizzle + Zod | Same as Memoir |
| Database | PostgreSQL with row-level security | Keeps each workspace's data apart inside the database itself |
| Background jobs | pg-boss | A queue that runs on Postgres, so no Redis. Used for payroll runs, recurring invoices, reorder alerts, emails, the nightly demo reset |
| Realtime | `@fastify/websocket` | Live stock counts, notifications |
| PDFs | pdfmake (server side) | Invoices, Form 2307, payslips, purchase orders, books of accounts |
| Excel | ExcelJS | Bulk import, report export |
| Barcodes | `expo-camera` (phone), `@zxing/browser` (web), `bwip-js` (labels) | |
| Gantt | frappe-gantt | Projects module |
| Passwords | `@node-rs/argon2` | Same as Memoir |

## 2. Free third-party services

| Need | Service | Free tier / catch |
|---|---|---|
| Database | Neon | 0.5 GB. Sleeps when idle |
| API hosting | Render | Sleeps after 15 min idle, so the first request takes about 50 s. Open the app a minute before a demo |
| Web hosting | Vercel Hobby | Non-commercial use only, which fits a showcase |
| Email | Brevo | 300 emails/day |
| Images | Cloudinary | Logos, product photos, clock-in selfies |
| Documents | Cloudflare R2 | 10 GB, free downloads. For PDFs and attachments |
| Phone builds | Expo EAS | Free tier has a monthly build limit |
| Push notifications | Expo Push | Free |
| Error tracking | Sentry | 5k errors/month |
| Analytics | PostHog | 1M events/month |
| Exchange rates | Frankfurter API | Free, no key |
| Philippine addresses | PSGC API | Region → province → city → barangay |
| Google sign-in | Google OAuth | Free |
| CI | GitHub Actions | Free minutes |
| Payments (demo) | PayMongo test mode | GCash, Maya and cards in test mode cost nothing |

**Phone app distribution:** for demos, share the Android APK directly (free). The Play Store costs
$25 once, and iOS TestFlight needs an Apple Developer account ($99/year). Both can wait.

---

## 3. User flow

```
Sign up / Sign in  (email + password, or Google)
      │
      ▼
Belongs to any workspace? ──yes──► Workspace switcher ──► Dashboard
      │ no
      ▼
 ┌─────────────┴──────────────┐
 Join workspace          Create workspace
 │                             │
 Enter code                   Business name, TIN, VAT or non-VAT,
 (e.g. ACME-7K3Q-9XPA)          registered address, fiscal year
 │                             │
 Code checked:                Pick a niche template (1–7)
  • not expired                │
  • not already used          Preview: modules turned on, chart of
  • matches workspace           accounts, sample settings
 │                             │
 Joins with the role          Workspace created → user is Owner
 the code was made for
```

### Join codes

- Only people with the `members.invite` permission can create codes. The Owner has it from the
  start and can give it to any role (for example HR Manager).
- Each code has an **assigned role** and an **expiry** (default 24 h), and is **used once**.
  A multi-use option can come later.
- The database stores only a hash of the code, the same way as a password.
- Join attempts are rate-limited so nobody can guess codes by trying thousands.
- Optional workspace setting: the owner must approve each person who joins.
- One user can belong to many workspaces and switches between them.

### Demo mode

- A "Try the demo" button on the landing page opens a ready-made workspace for any niche, filled with
  realistic Philippine sample data: pesos, Philippine addresses and holidays, payroll already run.
- A scheduled job resets the demo workspaces every night.

---

## 4. Architecture rules

1. **One database for all workspaces.** Every table has a `workspace_id` column, and Postgres
   row-level security is the second line of defence.
2. **The general ledger is the base layer.** Every module records its money effect as a journal
   entry. An invoice records Accounts Receivable and Revenue. Receiving goods records Inventory
   against goods received but not yet billed. A payroll run records Salary Expense against Cash and
   payroll liabilities. The ledger gets designed first.
3. **Posted records cannot be edited.** A posted invoice or journal entry is corrected with a
   reversing entry, not by editing or deleting it.
4. **Templates are configuration, not separate code.** A niche template is a JSON seed: modules
   turned on, chart of accounts, units of measure, custom fields, item tracking settings (lot,
   expiry, serial, variants), document number formats, default workflows. All seven niches run on
   the same engine.
5. **Roles are built from permissions.** Permissions are pairs of module and action
   (`inventory.adjust`, `payroll.run`, `members.invite`). Owner and Admin are built in, and users
   can create custom roles.
6. **Audit log from day one.** Every change records who made it, when, and the values before and
   after.
7. **Government rates are data, not code.** Every rate table (SSS, PhilHealth, Pag-IBIG, withholding
   tax, minimum wage, holidays) has an "effective from" date, and the system uses whichever version
   applies to the period. A new circular means adding a row, not redeploying.
8. **Document numbering** comes from a sequence per workspace and document type, with no gaps, as
   the BIR expects.

---

## 5. Core modules (every workspace)

| Module | What it includes |
|---|---|
| **Finance** | Chart of accounts, journals, general ledger, accounts payable and receivable, invoices, bills, payments, budgets, tax codes, bank reconciliation, trial balance, profit and loss, balance sheet |
| **Supply chain & inventory** | Items, units of measure, warehouses and bins, stock movements, purchase orders, goods receipts, suppliers, reorder points, picking, packing and shipping |
| **Manufacturing** | Bills of materials (multi-level), routings and work centres, work orders, production scheduling, quality control checks |
| **HR & payroll** | Employee records, attendance, leave, recruitment pipeline, payroll runs, payslips |
| **CRM** | Contacts and companies, leads, sales pipeline, quotes → sales orders, service tickets |
| **Projects** | Projects, milestones, tasks, resource allocation, timesheets, cost tracking, Gantt chart |

## 6. Niche templates

| # | Niche | Extra features |
|---|---|---|
| 1 | Food, Beverage & Perishables | Lot and expiry tracking, first-expiry-first-out picking, recipes, traceability for recalls, catch-weight items, cold-chain notes, FDA License to Operate and product registration numbers |
| 2 | Pharmaceuticals, Nutraceuticals & Cosmetics | Batch records, full lot history, quality hold and release, certificates of analysis, e-signatures, strict audit trail, FDA License to Operate and product registration with expiry reminders |
| 3 | Discrete & Custom Manufacturing (make-to-order / engineer-to-order) | Multi-level bills of materials, product configurator, quote-to-order, job costing, material requirements planning (MRP) |
| 4 | Chemical, Paint & Coatings | Formulas with ratios and batch scaling, density conversion (litres ↔ kg), yield and loss tracking, safety data sheets, hazard classes, tint and colour variants |
| 5 | Apparel, Footwear & Fashion | Style × size × colour grid, size runs, seasons and collections, simple product development, wholesale and retail price lists |
| 6 | Construction, Engineering & Field Services | Project-centred layout, job costing, progress billing with 10% retention, 2% withholding on contractor payments, contractor license (PCAB) record, subcontractors, equipment, field work orders, mobile timesheets |
| 7 | Wholesale Distribution | Multi-warehouse with bins, barcode scanning, tiered price lists, rebates, landed cost, drop-shipping, high-volume order entry |

---

## 7. Philippine compliance

> Check every rate against the latest BIR, SSS, PhilHealth, Pag-IBIG and DOLE issuances before
> seeding it. Rates live in tables with effective dates (rule 7 above).

### Finance and tax (BIR)

| Area | What to build |
|---|---|
| Invoices | Under the EOPT Act (RA 11976) the *invoice* is the main document for sales of goods and services alike. Invoices need the seller's TIN, registered name and address, a serial number, and the VAT shown separately |
| VAT | 12% VAT, zero-rated and VAT-exempt sales, input and output VAT accounts, summaries for **2550Q** |
| Non-VAT businesses | 3% percentage tax for **2551Q** |
| Expanded withholding tax | Withholding codes (ATC) on supplier bills, **Form 2307** per supplier, **0619-E** and **1601-EQ** summaries, QAP (alphalist of payees) |
| Withholding on wages | **1601-C** monthly, **2316** per employee each year, **1604-C** alphalist |
| Sales and purchase lists | Summary lists of sales and purchases (SLSP) exported in BIR's format |
| Books | General journal, general ledger, cash receipts book, cash disbursements book, printable as BIR-style books of accounts |
| Record keeping | Posted records can't be edited. Keep them at least 5 years under EOPT |

### Payroll (DOLE and the government agencies)

| Item | Rule (stored as a table) |
|---|---|
| SSS | 15% total (10% employer / 5% employee), brackets based on monthly salary credit, plus the separate WISP (provident fund) portion at higher salaries |
| PhilHealth | 5% of basic pay split 50/50, with a salary floor and ceiling |
| Pag-IBIG | 2% employee + 2% employer, capped at a ₱10,000 salary base |
| Withholding tax | TRAIN law tax table, with daily, weekly, semi-monthly and monthly versions |
| 13th month pay | Required (PD 851). Tax-exempt up to ₱90,000 together with other benefits |
| De minimis benefits | Set list with yearly caps |
| Premium pay | Overtime +25%, rest day +30%, special non-working day +30%, regular holiday 200%, night shift differential +10%. These stack, e.g. overtime on a holiday |
| Minimum wage | Table by region (each region's wage board order) |
| Holidays | Seeded each year. Admins can edit them because special non-working days get announced at short notice |
| Leave | Service incentive leave (5 days), plus maternity, paternity, solo parent and VAWC leave |
| Documents | Payslips, SSS R-3 and PhilHealth RF-1 contribution reports, Pag-IBIG remittance list |
| Final pay | Pay owed when someone leaves: last salary, 13th month pro-rata, unused leave converted to cash |

### Data Privacy Act (RA 10173)

- Consent and privacy notice at sign-up, and a privacy settings page in each workspace.
- Government ID numbers (TIN, SSS, PhilHealth, Pag-IBIG) are encrypted at rest.
- People can download or delete their own data (data subject rights).
- Each workspace names a data protection officer.
- A breach log, because breaches must be reported to the National Privacy Commission within 72 hours.

### Philippine data formats

- Address picker using the PSGC API: region → province → city/municipality → barangay.
- ID number formats, e.g. TIN `000-000-000-00000`.
- Currency in PHP (₱), with foreign currencies converted using Frankfurter rates.

---

## 8. Phone app scope

The phone app covers what people do away from a desk. It does not copy the whole ERP.

| Feature | Who uses it |
|---|---|
| Sign in, join a workspace with a code, switch workspaces | Everyone |
| Clock in/out with GPS and a selfie | Every employee (feeds attendance → payroll) |
| Leave requests, payslip viewer | Employees |
| Approvals (purchase orders, leave, expenses) | Managers and owners |
| Barcode scanning: stock counts, receiving, picking | Warehouse (wholesale, food) |
| Field work orders, timesheets, site photos | Construction and field services |
| Dashboard, push notifications | Owners |

Working offline (warehouse and field use) is planned for later and is not in the first version.
