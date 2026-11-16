# Niche templates

A niche is mostly configuration in [`packages/shared/src/templates.ts`](../packages/shared/src/templates.ts).
Code is added only for rules that are true of a whole industry. The template switches the rule on,
and the rule then works for any template that turns it on.

## What a template can set

| Setting | What it does | Example |
|---|---|---|
| `modules` | Modules turned on when the workspace is made | Construction: Projects, no Manufacturing |
| `accounts` | Accounts added to the standard chart; `key` marks one the system posts to | Food: Spoilage and Shrinkage (`spoilage`); Construction: Contract Revenue (`contract_revenue`) |
| `units` | Units added to the standard list | Pharma: vial, blister, tube, sachet |
| `itemDefaults` | How the item form starts | Food, Pharma: lots and expiry tracked |
| `itemFields` | Extra fields on items, checked on save. `requiredForSale` blocks a sale without it; `printed` puts it on delivery receipts and invoices | Pharma: FDA CPR number (required for sale); Chemical: UN number and hazard class (printed) |
| `licences` | The business's licences, in Settings → Workspace, printed on invoices. With `expires`, the dashboard warns 60 days ahead | Food, Pharma: FDA LTO; Construction: PCAB licence and category |
| `features` | Industry rules: `qcRelease`, `variants`, `hazard`, `makeToOrder` | see below |
| `retentionBp` | Share of each project milestone the customer holds back until turnover | Construction: 1000 (10%) |

Existing workspaces pick up new account keys and permissions through a migration (see
`0014_demo_accounts.sql`, `0016_manufacturing.sql`, `0017_projects.sql`).

## The packs

| Niche | What's specific to it |
|---|---|
| **Food** | Lot and expiry on every item; earliest expiry first, never an expired lot; spoilage to its own account; "Write off expired"; recipes and production; FDA LTO and CPR. The demo business. |
| **Pharma** | Lots received or made wait in **quarantine** (Inventory → Quality control) until released; a rejected lot is written off. No sale without the **FDA CPR number**. Generic name, dosage form, strength, Rx/OTC. FDA LTO. |
| **Discrete manufacturing** | **Make to order**: a sales order shows the work orders made for it and their cost against its price, with a "Make" button for lines that have a BOM. Drawing / part number and material on items. |
| **Chemical** | **UN number and hazard class** printed on delivery receipts and invoices; safety data sheet link; density. DENR hazardous waste ID. Drums, pails, gallons. |
| **Apparel** | **Size × colour variants** made from one style (each its own item and SKU), with a stock grid on the style. Season, colour, size. |
| **Construction** | **10% retention** held from each milestone invoice, and billed on one invoice at turnover; milestones and hours billed to Contract Revenue. **PCAB licence and category** printed on invoices. |
| **Wholesale** | **Price lists with quantity breaks** (Sales & CRM → Price lists), given to customers; quotes, orders and invoices fill in the customer's price. Brand and case pack on items. Price lists work in every template. |
| **General** | The standard chart, nothing extra. |

The tests for these are in [`apps/api/test/niches.test.ts`](../apps/api/test/niches.test.ts), and
`workspaces.test.ts` makes a workspace from every template.

## Adding a niche, or a rule

1. Add the template: modules, accounts (with keys), units, item fields, licences, highlights.
2. If the industry needs a rule, add a feature flag, put the rule in the engine behind
   `hasFeature(ws.template, …)`, and add a screen for the daily chore.
3. Add a test in `niches.test.ts`.
4. For a demo, copy the shape of `buildDemo` in `apps/api/src/features/demo/seed.ts`: create the
   workspace from the template through the API, add people with join codes, then let a day-by-day
   loop run the business.

## Left for later

- **Quarantined Inventory as its own account** (Pharma). Held lots stay in Inventory and are only
  kept from sale. Moving their value between accounts on release would show it in the books.
- **Retention in the books** (Construction). Retention isn't revenue until it's billed. Booking it
  to Retention Receivable as each milestone is billed would follow PFRS 15 more closely.
- **Litres ↔ kilograms** (Chemical): density is recorded, but quantities don't convert yet.
- **Landed cost** (Wholesale): freight spread over the goods it brought in.
- **A product configurator** (Discrete): options on a sales order that pick the BOM.
- **A demo for each niche**: only Food has one.
