# ERP — Roadmap

What gets built, in what order. The product and technical decisions are in [plan.md](plan.md).

Estimates assume 1–2 developers working on it as a side project.

| Phase | Scope | Est. |
|---|---|---|
| **0. Foundations** ✅ | Monorepo (`apps/web`, `apps/api`, `apps/mobile`, `packages/shared`), CI on GitHub Actions, Drizzle migrations, port Memoir's login code, UI kit, app shell and navigation | Done |
| **1. Workspaces & access** ✅ | Create a workspace from one of 8 niche templates, join with a one-time code, roles and permissions (5 built in, plus custom), audit log, PSGC address picker, Settings pages (workspace, members, join codes, roles, audit log), data protection officer. See "Phase 1 notes" below | Done |
| **1M. Phone app shell** ✅ | Expo app: sign in and sign up, join with a code, workspace switcher, the workspace's money and latest invoices, push notifications (someone joined, your role changed). See "Phase 1M notes" | Done |
| **2. Finance (BIR)** ✅ | Chart of accounts, general ledger, manual journal entries with reversal, EOPT sales invoices, bills, payments, VAT and percentage tax, expanded withholding with Form 2307, books of accounts, trial balance, profit and loss, balance sheet, VAT / percentage tax / withholding summaries, summary lists of sales and purchases. See "Phase 2 notes" below | Done |
| **3. Inventory & purchasing** ✅ | Items, units, warehouses, stock moves at moving average cost, adjustments and counts, transfers, purchase orders → receipts → bills (GRNI and price variance), invoices taking stock out (earliest expiry first), reorder alerts, lot and expiry tracking, stock valuation. **Phone:** barcode lookup and counting. See "Phase 3 notes" | Done |
| **4. CRM & sales** ✅ | Customers with payment terms and credit limits, leads, pipeline board, activity log, quote → sales order → delivery receipt → invoice, partial deliveries. See "Phase 4 notes" | Done |
| **5. HR & payroll (Philippines)** ✅ | Employees with encrypted government IDs, clock-in with location, leave with balances, holidays, a payroll engine on effective-dated government rates (SSS, PhilHealth, Pag-IBIG, TRAIN tax, premium pay), 13th month pay, payslips, 1601-C, 2316, R-3, RF-1 and Pag-IBIG lists. **Phone:** GPS clock-in, payslips, leave requests, leave approvals. See "Phase 5 notes" | Done |
| **Investor demo** ✅ | Phases 0–5, the **Food** template finished, "Try the demo" (a copy each, wiped nightly), Android APK build set up. See "Investor demo notes" | Built; goes online with [deploy.md](deploy.md) |
| **6. Manufacturing** ✅ | Multi-level bills of materials with routings at work centres, work orders (materials into Work in Process, labour and overhead applied, output by lot), quality checks, MRP that suggests what to make and buy. In the Food demo: a premix room. See "Phase 6 notes" | Done |
| **7. Projects** ✅ | Projects for a customer (fixed price by milestone, or by the hour) or internal; tasks with dependencies on a Gantt chart; timesheets; job costing (labour, materials from stock, tagged bills, against invoices); billing milestones and hours. **Phone:** field work orders (my tasks: start, progress, done with location, log hours). See "Phase 7 notes" | Done |
| **8. Niche packs** ✅ | Every template finished: item fields and licences (FDA LTO and CPR, PCAB), Pharma's quarantine and QC release, Chemical's hazard details on documents, Apparel's size × colour variants, Construction's 10% retention, Wholesale's price lists with quantity breaks, Discrete's make-to-order. See "Phase 8 notes" and [niche-templates.md](niche-templates.md) | Done |
| **9. Polish** ✅ | Dashboard with charts and a "needs attention" list, Excel and CSV import (items, customers and suppliers, opening stock), pages loaded on demand, slow queries fixed, security review with tests and security headers, a landing page at `/`. See "Phase 9 notes" | Done |

## Order of work

- **The ledger comes first** (Phase 2). Every later module records its money effect in it.
- **Payroll comes before manufacturing.** Philippine payroll is the hardest compliance work in the
  plan, and seeing it run correctly is what convinces investors the product is real. Manufacturing
  only matters to some of the niches.
- **The investor demo has one niche done well.** Wholesale or Food needs the least manufacturing, so
  either can be finished first.
- **Phase 2 was built before Phase 1** (by choice). Finance needs a business to belong to, so the
  workspace core it depends on was built with it, and Phase 1 completed it afterwards.

## Phase 9 notes

What it does:

- **Dashboard** (`GET /dashboard`, one call). With `finance.view`:
  - Income and expenses by month.
  - Cash and bank at each month's end.
  - What customers owe, by age (current, 1–30, 31–60, 61–90, 90+ days).
  - The top 5 customers over the last 90 days.

  Months before the business's first entry are left off. For everyone, "Needs attention" counts what is waiting on them, limited to what their role can see: overdue invoices, bills due, stock below reorder point, expired lots, lots in quarantine, orders to deliver, open work orders, leave to approve, my tasks. Charts are plain SVG (`components/charts.tsx`), with hover tooltips, a table for screen readers, and colours checked for colour blindness in light and dark.
- **Excel import** (Settings → Import, `POST /import/:kind`). Covers items, customers and suppliers, and opening stock.
  - Download a template, fill it in, and upload `.xlsx` or `.csv`. Headers are matched by name, and columns can be in any order.
  - **Check** runs every row through the same rules as the forms and lists errors by sheet row, without saving.
  - **Import** saves every row or none.
  - Items and contacts already there (same SKU, or same name) are updated, not duplicated.
  - Opening stock is posted as stock adjustments, so the ledger stays balanced.
  - Limits: 5,000 rows, 5 MB, 20 imports a minute.
- **Landing page** at `/`, for anyone not signed in. Covers the modules, the Philippine rules, the 8 industries, the phone app and "Try the demo". Signed-in users still go straight to their workspace. The screenshots in `public/landing/` are taken from the demo.
- **Speed.**
  - Each page is loaded when first opened. The first download went from 1.15 MB to 363 KB (112 KB compressed). The Excel reader (930 KB) loads only on the import page.
  - The stock documents list made one query per document; it now makes 3 in all (603 queries down to 3 for 200 documents).
  - Bills of materials and unit costs now batch their queries too (17 queries down to 10, and no longer growing with the number of BOMs).
  - Locally, most pages' API calls take under 20 ms.
- **Security review.**
  - New `security.test.ts`: another business's workspace answers "not found". 23 attempts to read or change B's records through A's workspace (invoices, items, employees, projects, BOMs and so on) are refused, and B is unchanged.
  - Writes from another website are refused, and the security headers are checked.
  - The web app now sends its own security headers (`vercel.json`). Scripts may only come from the app itself, so the dark-mode script moved out of `index.html` into `public/theme.js`. It also cannot be framed, does not leak referrers, and uses HSTS.
  - CSV exports put a `'` before cells that start with `=`, `+`, `@` or `-` text, so Excel won't run them as formulas.

Checked and left as is:

- `npm audit` reports 5 moderate advisories. Four are in Expo's build tools (minimatch); they don't reach the app. One is `uuid` inside ExcelJS's browser bundle; the affected code path isn't used. Upgrading them means a breaking Expo upgrade or forking ExcelJS, which isn't worth it now. Look again at the next Expo SDK upgrade.

Later:

- Postgres row-level security as a second guard behind workspace checks in the code.
- Limit the web CSP's `connect-src` to the API's own address once it has a fixed domain (now: any `https:`).
- More import kinds: employees (with government IDs), chart of accounts opening balances, open invoices.
- Saved dashboard layouts, and date ranges other than the last 6 months.

## Phase 8 notes

What it does:

- **Templates carry more configuration**: extra item fields (checked on save, some required before
  a sale, some printed on documents), the business's licences (printed on invoices, with an expiry
  warning on the dashboard 60 days ahead), feature flags for industry rules, and a retention rate.
  The full list is in [niche-templates.md](niche-templates.md).
- **Pharma**: lots received from suppliers or made in production start in quarantine. They count
  as stock but can't be sold or used until released on Inventory → Quality control. A rejected lot
  is written off to Rejected and Expired Stock. An item without its FDA CPR number can't be sold.
- **Chemical**: UN number and hazard class print under the item on delivery receipts and invoices.
- **Apparel**: a style's colours × sizes become their own items (SKU-COLOUR-SIZE), with a stock
  grid on the style.
- **Construction**: each milestone invoice holds back 10% (set per project), and the retention is
  billed on one invoice once every milestone is billed or the project is completed. Voiding or
  deleting that invoice frees it to bill again. PCAB licence and category on the business.
- **Wholesale**: price lists with quantity breaks, given to customers. Quotes, orders and invoices
  fill in the customer's price when an item is picked or the quantity changes. They're available to
  every template, under Sales & CRM.
- **Discrete**: a work order can be made for a sales order, and the order shows its production cost
  against its price.
- **Fixed along the way**: when goods couldn't be sold, the error now says how many are expired and
  how many are waiting for quality control, separately.

Left for later: see the end of [niche-templates.md](niche-templates.md). Also, a price filled in
from a price list is replaced when the quantity changes, even if it was edited by hand.

## Phase 7 notes

What it does:

- A **project** (PRJ-) is for a customer, billed at a fixed price by milestones or for time and
  materials at an hourly rate, or internal (not billed). It has a cost budget, a site address, a
  manager and a status.
- **Tasks** have dates, an assignee, estimated hours, progress and the task they wait for (a loop is
  refused). The Gantt chart shows them with the milestones and a line at today. A task marked
  **field work** shows on the assignee's phone with where to go; starting it, updating it and
  marking it done happen there, and "done" records where the phone was. Assigning a task sends a push.
- **Timesheets**: members log their own hours (on the web under My time & pay, or on the phone); a
  project manager may log anyone's. Each entry is costed at the employee's daily rate ÷ 8 when it's
  logged. Logging time on a task that hadn't started starts it.
- **Job costing**: labour (timesheets), materials taken from stock (Dr Direct Project Costs /
  Cr Inventory, earliest expiry first, never expired), and posted bills tagged to the project, all
  before VAT; against posted invoices tagged to it. Percent complete is task progress weighted by
  estimated hours; the forecast is cost to date ÷ percent complete. Labour is costed for the project
  only: payroll already books the wages, so timesheets make no journal entry.
- **Billing**: a milestone, or the billable hours not yet billed (one line per task), becomes a draft
  invoice to the customer at their payment terms, to Contract Revenue (Construction) or Service
  Revenue. Voiding or deleting it frees them to bill again. Invoices and bills have a Project field.
- New account Direct Project Costs (5600), new permissions and a Project manager role.
- **Fixed along the way:** the Construction template's Retention Payable and Billings in Excess of
  Costs used codes 2210 and 2220, which the standard chart has used for payroll since Phase 5, so a
  Construction workspace couldn't be created. They're now 2250 and 2260, and a test makes a
  workspace from every template.
- **The Food demo** has an internal project (the cold room expansion: contractors' bills, warehouse
  hours, tasks for the visitor including field work) and an hourly service to the hotel, partly
  billed.

Left for later:

- **Progress billing with retention** (the Construction niche): milestones bill in full for now.
- **Labour in the books**: job costs show labour; a journal entry moving it from Salaries to the
  project (or to Work in Process) would make the ledger's project costs complete.
- **Approving timesheets**, and timesheets from clock-ins.
- **Resource levelling**, and dragging bars on the Gantt chart (dates are edited in the task).
- **Change orders** and contract variations; **returning** materials from a project to stock.
- **Photos** on field work (with the clock-in selfies).

## Phase 6 notes

What it does:

- **Bills of materials** (BOM-SKU-1): what one batch of a product takes, the routing (steps at work
  centres, minutes per batch), and the quality checks. Components can be made too (multi-level);
  a BOM that would contain its own product is refused. Each product has one active version; a new
  version replaces it, and old work orders keep their own copy. The cost per unit rolls up from
  average costs (or, for a made component not in stock, its own BOM) plus labour and overhead.
- **Work centres** have a cost per hour (wages and overhead), which is what a minute there adds to a
  product's cost.
- **Work orders** (WO-): draft → released (numbered) → started → completed, or cancelled. Starting
  takes the materials out of stock (earliest expiry first, never an expired lot) at moving average
  cost: Dr Work in Process / Cr Inventory. Completing records the minutes actually spent and every
  quality check (a failed check needs a reason and rejected units), then books
  Dr Inventory (good units, as a new lot with its best-before date) and Dr Spoilage (rejects) /
  Cr Labor and Overhead Applied, Cr Work in Process. A completed work order can't be changed (a
  database trigger); cancelling a started one puts its materials back.
- **Planning (MRP)** works out, level by level through the BOMs, what open sales orders, reorder
  points and work orders need against stock (not expired), purchase orders and work orders on their
  way. It suggests what to make (draft work orders, one click) and what to buy (draft purchase
  orders per supplier, defaulting to the last one bought from).
- New accounts for every workspace: Work in Process (1215) and Labor and Overhead Applied to
  Production (5410, a contra expense). New permissions and a Production staff role. The Discrete
  and Chemical templates' own Work in Process account became the standard one.
- **The Food demo** blends its own pandesal and chocolate cake premixes: a blending room and a
  packing line, weekly work orders with the odd bag rejected in QC, and for the visitor one work
  order to complete and one to start.

Left for later:

- **Phone screens** for the production floor (start, record output, QC). Done on the web for now.
- **By-products and co-products**, and **scrap allowances** on BOM lines.
- **Partial completion** (several outputs from one work order) and **issuing more material** after
  starting; a work order is started and completed once.
- **Capacity scheduling**: the load is shown per work centre; nothing moves work orders to fit it.
- **Lead times** in MRP: suggestions are for now, not dated backwards from when they're needed.
- **Unit conversion** in BOMs (kg of an item bought by the sack): quantities are in the item's unit.
- A held/quarantined state for output awaiting QC release (the Pharma niche wants it).

## Investor demo notes

What it does:

- **Food is the finished niche** (it has the most process: lots, expiry, spoilage, and production
  later), and the pattern for the rest: see [niche-templates.md](niche-templates.md). Templates now
  carry their own units, item defaults and system accounts. Write-offs for damage or expiry post to
  Spoilage and Shrinkage. Sales and deliveries never take an expired lot (for every template: nobody
  should sell expired goods), and the Inventory overview has "Write off expired".
- **"Try the demo"** (sign-in page, phone sign-in, and the shareable link `/demo`) gives each visitor
  their own copy of Sariwa Food Supply Co., a made-up Quezon City food distributor, signed in as its
  owner. Three months of history, built through the API as the staff would do it: about ₱3 million
  in sales a month, purchase orders and receipts by lot, spoilage, payroll posted and paid with
  remittances, leads and quotes, clock-ins with location. Left for the visitor: two leave requests,
  a half-delivered order, an expired lot, this period's payroll.
- A spare copy is kept built (it takes 15–60 s); copies are wiped at 3 a.m. Manila time. The yellow
  bar shows the password that opens the same copy on the phone.
- "Create invoice" on a sales order can take a date (the builder bills on the delivery date).
- **Needs you:** accounts on Neon, Render, Vercel and Expo to put it online and build the APK
  ([deploy.md](deploy.md)). Nothing is deployed yet.

Left for later:

- ~~Manufacturing for Food~~: done in Phase 6 (the demo blends its own premixes).
- **Holidays after 2026** aren't seeded, so a demo built in 2027 has none until they're added.
- The demo's dates move with the day it's built; a spare is at most a week old.

## Phase 5 notes

What it does:

- Government rates are rows in `gov_rates` with the date each applies from (SSS 2025, PhilHealth 5%,
  Pag-IBIG ₱10,000 cap, the TRAIN withholding tables, premium pay, the ₱90,000 13th-month exemption,
  NCR minimum wage). Payroll uses whichever rows are in force at the end of the period it pays. The
  sources are on HR → Settings. **Check them against the latest issuances**; NCR's ₱755 (Wage Order
  NCR-28, from Sept 26, 2026) was reported as disputed when it was added.
- A payroll run is worked out per person from clock-ins, approved leave and holidays: absences,
  lateness and undertime, overtime, work on rest days, special days and regular holidays, and night
  differential. People who don't clock in are paid in full. Any line can be edited before posting
  (allowances, de minimis, deductions such as cash advances), and edited lines keep their figures.
- Contributions are taken once a month, in the run that ends the month, on the whole month's pay.
  Tax uses the semi-monthly or monthly table on pay less contributions; minimum wage earners pay none.
- Posting numbers the run (PR-), books it (salaries, the employer's share, the agencies' payables,
  withholding tax, other deductions, salaries payable), and sends each linked employee a push. Marking
  it paid clears Salaries Payable. A posted run can't be changed, by a database trigger; a run whose
  deductions exceed someone's pay can't be posted.
- 13th month pay: a twelfth of the year's basic pay from posted payroll, tax-free up to ₱90,000; the
  tax on any excess is the difference it makes to the annual tax.
- Reports for a month: 1601-C figures, SSS R-3, PhilHealth RF-1 and the Pag-IBIG list (CSV each);
  and BIR 2316 per employee per year.
- Government ID numbers are encrypted at rest, shown in full to HR managers and masked to viewers;
  pay is shown only to roles with "payroll.run". New permissions and an "HR & payroll" role.
- Every member linked to an employee record has "My time & pay" (web) and the phone screens: clock in
  and out with location, leave balances and requests, and payslips. Managers decide leave on the phone.
- Holidays for 2026 (Proclamation No. 1006) and the statutory leave types are seeded and editable.

Left for later:

- **Annualized tax at year end** (the 2316 shows the difference to refund or collect, but no run
  settles it), and **final pay** for people who leave.
- **Loans** (SSS, Pag-IBIG salary loans) as their own deductions with balances; for now they're
  entered as deductions on the payroll line.
- **Overtime approval.** Overtime is counted from clock-ins; HR edits the line if it wasn't approved.
- **Clock-in selfies** and a **geofence** for the work site. Location is recorded, not checked.
- **Minimum wages** for regions other than NCR, and editing government rates in the app.
- **BIR file formats** (alphalist DAT, eFPS) and the agencies' upload formats; CSV only for now.
- **Holiday pay rules** in full (pay for an unworked regular holiday doesn't check attendance on the
  day before), and a 13th month split between June and December.

## Phase 4 notes

What it does:

- A lead moves through New → Qualified → Quote sent → Negotiating → Won or Lost (a reason is
  required for lost). "Make a customer" turns its company into a customer. Sending a quote moves its
  lead to Quote sent, and an accepted quote wins it. The pipeline is a board: drag a card to move it.
- Quotes (QT-) get their number when sent and can't be accepted once past their valid-until date;
  "Revise as a copy" makes a new draft at today's date. An accepted quote becomes a draft sales order.
- Sales orders (SO-) get their number when confirmed. Confirming is refused when it would take the
  customer past their credit limit, counting unpaid invoices and other orders not yet invoiced.
- A delivery (DR-, printable delivery receipt) takes the stock out, earliest expiry first, and posts
  Dr Cost of Sales / Cr Inventory. Partial deliveries are fine.
- "Create invoice" on an order drafts an invoice for what was delivered and not yet invoiced (and any
  services), due after the customer's payment terms. Posting it books only the sale, and it can't
  bill more than went out. Voiding it frees those quantities to invoice again; the goods stay delivered.
- Calls, meetings, emails and notes can be logged on a lead or a customer; a customer's page shows both.
- New permissions (Sales & CRM view / manage, Sales orders manage) and a Sales role. Warehouse staff
  deliver; sales staff can't post invoices or move stock.
- Fixed along the way: an order (purchase or sales) that closed itself reopens if one of its bills or
  invoices is voided; one closed by hand stays closed. Migrations take a database lock, so test files
  (and two servers starting at once) no longer race on a fresh database.

Left for later:

- **Service tickets** (in the plan's CRM module).
- **Voiding a delivery, and customer returns.** A wrong delivery is corrected with a stock adjustment.
- **Discounts** on quote and order lines, and price lists (the Wholesale niche's tiered prices).
- **Stock reservations.** Confirming an order doesn't hold stock; the form warns when there isn't enough.
- **Sending quotes by email.** Quotes print or save to PDF from the browser.
- **The phone app** has no sales screens yet.

## Phase 3 notes

What it does:

- Stock is valued at moving average cost. Every movement posts its own journal entry, so the
  stock valuation always equals the Inventory account (a test checks it to the centavo).
- Purchasing is three-way: receiving goods posts Dr Inventory / Cr Goods Received Not Invoiced;
  the supplier's bill (made from the PO) clears GRNI, and a price different from the PO's goes to
  Purchase Price Variance. A stock item can't be put straight on a bill: it must come through a PO.
- Posting an invoice with stock items takes them out of its warehouse (earliest-expiring lot
  first) and books cost of sales in the same entry. Voiding the invoice puts the stock back.
- Stock moves can't be changed or deleted, by a database trigger, like posted entries.
- An item dropping to its reorder point sends a push to the people who manage stock.
- New permissions (Inventory view / manage, Purchasing manage) and a Warehouse staff role. Inventory
  routes refuse to work when the module is turned off.

Left for later:

- **Units of measure conversion** (buying in boxes, selling in pieces). Each item has one unit.
- **Voiding a goods receipt or an adjustment.** Corrections are made with a new adjustment.
- **Per-item inventory and cost-of-sales accounts.** All stock uses the Inventory and Cost of Sales
  accounts.
- **Rounding:** when one PO line is received in several deliveries, each is rounded to the
  centavo, so GRNI can be left with a centavo or two. A year-end clean-up will handle it.

## Phase 1M notes

- The session token lives in the phone's keychain (iOS) or keystore (Android), and lasts 30 days.
- Push notifications go through Expo's free push service. Sending never slows down or fails the
  request that caused it. A shared phone notifies only whoever signed in on it last, and signing
  out stops them.
- **Needs you:** push notifications only work in a build linked to an Expo project (`npx eas init`,
  then a development build). Expo Go on Android can't receive them.
- **Not yet on the phone:** creating a workspace (done on the web), entering invoices and bills.
  The phone gets the field work in later phases: scanning (3), clock-in and payslips (5), work
  orders (7).

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
