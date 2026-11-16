# ERP

A multi-tenant ERP for Philippine businesses, on the web and on phones. People join a workspace with a
one-time code or create one from a template made for their kind of business.

**Status:** Phases 0, 1, 1M (the phone app), 2 (Finance, following BIR rules), 3 (Inventory and purchasing), 4 (Sales & CRM), 5 (HR & payroll), 6 (Manufacturing), 7 (Projects), 8 (the niche packs) and 9 (polish: dashboard, Excel import, speed, security review, landing page) are done, and so is the investor demo (the Food niche finished, and "Try the demo"). See [docs/roadmap.md](docs/roadmap.md).

**Try the demo:** the sign-in page's "Try the demo" button (or `/demo`) opens your own copy of a
food distributor with three months of history. To put it online and build the Android APK, see
[docs/deploy.md](docs/deploy.md).

- [docs/plan.md](docs/plan.md): tech stack, free services, user flow, modules, niche templates,
  Philippine compliance
- [docs/roadmap.md](docs/roadmap.md): build phases and the investor demo milestone
- [docs/deploy.md](docs/deploy.md): putting the demo online (Neon, Render, Vercel) and building the APK
- [docs/niche-templates.md](docs/niche-templates.md): the niche templates, what each one adds, and how to add one

## What's in the repo

| Folder | What it is |
| --- | --- |
| [`apps/api/`](apps/api/) | The API: Node + Fastify + PostgreSQL (Drizzle). Accounts, workspaces, Finance (ledger, invoices, bills, payments, reports), Inventory and purchasing, Sales & CRM, HR & payroll, Manufacturing, Projects. |
| [`apps/web/`](apps/web/) | The web app: React + Vite + Tailwind + shadcn/ui, TanStack Router and Query. |
| [`apps/mobile/`](apps/mobile/) | The phone app: Expo (React Native). Sign in, join with a code, switch workspaces, see the money; scan stock; clock in, leave and payslips; field tasks; push notifications. |
| [`packages/shared/`](packages/shared/) | Validation rules and API types used by all three. |

## Run it locally

Needs Node 22.18 or newer (24 recommended, see `.nvmrc`) and Docker Desktop.

```sh
npm install
cp -n apps/api/.env.example apps/api/.env   # -n: never overwrite an existing one. Then set ENCRYPTION_KEY (see the file)
npm run db:up                            # PostgreSQL on port 5433
npm run psgc:load -w @erp/api            # once: Philippine regions → barangays for the address picker
```

`psgc:load` downloads the official list from psgc.gitlab.io (about 11 MB) into the database.
Without it the app still works; addresses are typed into one box instead of picked.

Then start the API and the web app together:

```sh
npm run dev        # API on http://127.0.0.1:4100 and web app on http://127.0.0.1:5180
```

Open http://127.0.0.1:5180. Both must be running: the web app alone shows "The server isn't
answering". (`npm run dev:api` and `npm run dev:web` start them one at a time, in two terminals.)

The API keeps one demo business built in the background (about 15 s after it starts; set
`DEMO_SPARES=0` in `apps/api/.env` to skip it, or `DEMO=off` to turn the demo off).

With no email service set up, confirmation and password-reset links are printed in the API's
terminal. Open the link from there to confirm a new account. After signing in you choose to
create a workspace (pick a kind of business, then its details) or join one with a code. To try
roles, make a code in Settings → Join codes and sign up a second account to use it.

Money is stored as whole centavos everywhere (₱1,234.50 is `123450`). Posted records can't be
changed, even directly in the database; see [migration 0002](apps/api/src/db/migrations/0002_posted_records_are_final.sql).

### The phone app

```sh
npm run dev:mobile     # Expo: scan the QR code with Expo Go, or press i / a for a simulator
```

It signs in, joins a workspace with a code, switches workspaces, shows the workspace's money and
latest invoices, and scans barcodes to look up and count stock. Where it finds the API:

- **iOS simulator:** works as is (`http://127.0.0.1:4100`).
- **Android emulator:** `EXPO_PUBLIC_API_URL=http://10.0.2.2:4100 npm run dev:mobile`
- **A real phone on the same Wi-Fi:** start the API with `HOST=0.0.0.0`, then
  `EXPO_PUBLIC_API_URL=http://<your computer's Wi-Fi IP>:4100 npm run dev:mobile`

To try it in a browser instead, start the API with `EXTRA_ORIGINS=http://localhost:8081` and run
`npm run web -w @erp/mobile`.

**Push notifications** need a real phone and an Expo project: run `npx eas init` in `apps/mobile`
(free account), then make a development build (`npx eas build --profile development`). Expo Go
can't receive them on Android. Until then the Account screen says what's missing, and nothing
else is affected.

## Checks

```sh
npm run lint        # oxlint
npm run typecheck   # every workspace
npm test            # API tests, against the local database (npm run db:up first)
npm run build       # production build of the web app
```

GitHub Actions runs all four on every push to `main` and on pull requests.

## Changing the database

Edit [apps/api/src/db/schema.ts](apps/api/src/db/schema.ts), then:

```sh
npm run db:generate -w @erp/api -- --name what-changed
```

The API applies new migrations when it starts.
