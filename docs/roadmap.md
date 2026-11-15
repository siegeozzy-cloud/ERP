# ERP — Roadmap

What gets built, in what order. The product and technical decisions are in [plan.md](plan.md).

Estimates assume 1–2 developers working on it as a side project.

| Phase | Scope | Est. |
|---|---|---|
| **0. Foundations** ✅ | Monorepo (`apps/web`, `apps/api`, `apps/mobile`, `packages/shared`), CI on GitHub Actions, Drizzle migrations, port Memoir's login code, UI kit, app shell and navigation | Done |
| **1. Workspaces & access** | Create/join workspace, join codes, roles and permissions, audit log, template engine with one test template, Philippine address and ID fields, privacy consent | 2 wk |
| **1M. Phone app shell** | Expo app: sign in, join with a code, workspace switcher, push notifications | 1 wk |
| **2. Finance (BIR)** | Chart of accounts, ledger, EOPT invoices, VAT and percentage tax, withholding with Form 2307, books of accounts, trial balance, profit and loss, balance sheet | 3–4 wk |
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

## Later, not planned yet

- Working offline on the phone app (warehouse and field use)
- iOS release through TestFlight ($99/year Apple Developer account)
- Live payments through PayMongo
- BIR registration (CAS permit) and e-invoicing, if the project goes commercial
- Paid hosting tiers, if the project goes commercial
