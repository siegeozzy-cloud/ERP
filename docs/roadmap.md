# ERP — Roadmap

What gets built, in what order. The product and technical decisions are in [plan.md](plan.md).

Estimates assume 1–2 developers working on it as a side project.

| Phase | Scope | Est. |
|---|---|---|
| **0. Foundations** ✅ | Monorepo (`apps/web`, `apps/api`, `apps/mobile`, `packages/shared`), CI on GitHub Actions, Drizzle migrations, port Memoir's login code, UI kit, app shell and navigation | Done |
| **1. Workspaces & access** ✅ | Create a workspace from one of 8 niche templates, join with a one-time code, roles and permissions (5 built in, plus custom), audit log, PSGC address picker, Settings pages (workspace, members, join codes, roles, audit log), data protection officer. See "Phase 1 notes" below | Done |
| **1M. Phone app shell** | Expo app: sign in, join with a code, workspace switcher, push notifications | 1 wk |
| **2. Finance (BIR)** ✅ | Chart of accounts, general ledger, manual journal entries with reversal, EOPT sales invoices, bills, payments, VAT and percentage tax, expanded withholding with Form 2307, books of accounts, trial balance, profit and loss, balance sheet, VAT / percentage tax / withholding summaries, summary lists of sales and purchases. See "Phase 2 notes" below | Done |
| **3. Inventory & purchasing** | Items, units of measure, warehouses, stock movements, purchase orders → receipts → bills with withholding, suppliers, reorder alerts, lot/expiry. **Phone:** barcode scanning | 3 wk |
| **4. CRM & sales** | Customers, leads, pipeline, quote → sales order → delivery → invoice | 2–3 wk |
| **5. HR & payroll (Philippines)** | Employees, attendance, leave, payroll engine with the government rate tables, 13th month pay, payslips, government reports (1601-C, 2316, R-3, RF-1). **Phone:** GPS clock-in, payslips, leave requests | 4 wk |
| ✅ **Investor demo** | Phases 0–5, one niche template fully finished (**Wholesale** or **Food**), "Try the demo" button with nightly reset, Android APK | |
| **6. Manufacturing** | Bills of materials, routings, work orders, quality control, simple MRP | 3–4 wk |
| **7. Projects** | Milestones, tasks, timesheets, job costing, Gantt. **Phone:** field work orders | 2 wk |
| **8. Niche packs** | The remaining templates one at a time, including FDA and PCAB fields | 1–2 wk each |
| **9. Polish** | Dashboards, Excel import, performance, security review, pitch-ready landing page | 2 wk |

## Order of work

- **The ledger comes first** (Phase 2). Every later module records its money effect in it.
- **Payroll comes before manufacturing.** Philippine payroll is the hardest compliance work in the
  plan, and seeing it run correctly is what convinces investors the product is real. Manufacturing
  only matters to some of the niches.
- **The investor demo has one niche done well.** Wholesale or Food needs the least manufacturing, so
  either can be finished first.
- **Phase 2 was built before Phase 1** (by choice). Finance needs a business to belong to, so the
  workspace core it depends on was built with it, and Phase 1 completed it afterwards.

## Phase 1 notes

What it does:

- Every workspace API route has to name the permission it needs, or the server refuses to start,
  so a route can't be left unguarded by accident. The web app hides what a role can't use, and
  the API refuses it anyway.
- Only an owner can make, change or remove an owner, and a workspace always keeps at least one.
  Nobody can give a role permissions they don't have themselves.
- Join codes (e.g. `7K3Q-9XPA`) are stored only as a hash and work once. They expire after 1 hour,
  24 hours or 7 days, and can be revoked. Wrong codes lock the person out for longer each time.
- The audit log is append-only: a database trigger refuses edits and deletes, as for posted
  records. Every Finance change and every Settings change is in it.
- Templates add their own accounts to the chart and turn on their modules. The deeper parts of
  each niche (lot tracking, formulas, progress billing) come with the modules they belong to.

Left for later:

- **Owner approval for new members** (the plan listed it as optional). A code still lets someone in
  straight away.
- **Data Privacy Act requests and breach log.** People can't yet download or delete their own data
  from the app, and there's no breach log. The DPO's name and email are kept.
- **PSGC addresses for customers and suppliers.** Their addresses are still free text.

## Phase 2 notes

What it does:

- Posted invoices, bills, payments and journal entries can't be edited or deleted. Database
  triggers enforce this, not just the app. Mistakes are fixed by voiding (documents) or
  reversing (manual entries), and the original stays on record.
- Document numbers (SI-, BILL-, CR-, PV-, JE-) are taken in sequence inside the posting
  transaction, so there are never gaps.
- Tax rates are stored with the date they apply from, and each document uses the rate in force
  on its date.
- Invoices, bills and the BIR summaries print from the browser, labelled "Demo – not registered
  with the BIR".

Left for later:

- **Row-level security** in Postgres. Every query is scoped to its workspace, and tests check that
  one workspace can't reach another's data. The database-level safety net still needs a
  non-superuser database role, which the local Docker setup doesn't have yet.
- **Budgets and bank reconciliation** (listed in the plan's Finance module).
- **Year-end closing entries and locked periods.** Until then, the balance sheet shows earnings
  not yet closed as a line in equity.
- **Editing tax codes in the app.** The list is shown but read-only for now.
- **Automatic percentage tax entry.** The 2551Q summary works out the tax, but nothing posts it
  to the ledger yet.
- **BIR file formats.** The QAP and summary lists download as CSV, not BIR's own DAT format.
- **PDF files.** Documents print or save to PDF from the browser; pdfmake isn't used yet.

## Later, not planned yet

- Working offline on the phone app (warehouse and field use)
- iOS release through TestFlight ($99/year Apple Developer account)
- Live payments through PayMongo
- BIR registration (CAS permit) and e-invoicing, if the project goes commercial
- Paid hosting tiers, if the project goes commercial
