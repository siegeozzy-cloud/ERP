# ERP

A multi-tenant ERP for Philippine businesses, on the web and on phones. People join a workspace with a
one-time code or create one from a template made for their kind of business.

**Status:** Phase 0 (foundations), Phase 1 (workspaces, join codes, roles, audit log) and Phase 2
(Finance, following BIR rules) are done. See [docs/roadmap.md](docs/roadmap.md).

- [docs/plan.md](docs/plan.md): tech stack, free services, user flow, modules, niche templates,
  Philippine compliance
- [docs/roadmap.md](docs/roadmap.md): build phases and the investor demo milestone

## What's in the repo

| Folder | What it is |
| --- | --- |
| [`apps/api/`](apps/api/) | The API: Node + Fastify + PostgreSQL (Drizzle). Accounts, workspaces, and Finance: ledger, invoices, bills, payments, reports. |
| [`apps/web/`](apps/web/) | The web app: React + Vite + Tailwind + shadcn/ui, TanStack Router and Query. |
| [`apps/mobile/`](apps/mobile/) | The phone app: Expo (React Native). For now it only checks it can reach the API. |
| [`packages/shared/`](packages/shared/) | Validation rules and API types used by all three. |

## Run it locally

Needs Node 22.18 or newer (24 recommended, see `.nvmrc`) and Docker Desktop.

```sh
npm install
cp apps/api/.env.example apps/api/.env   # then set ENCRYPTION_KEY (the command is in the file)
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

With no email service set up, confirmation and password-reset links are printed in the API's
terminal. Open the link from there to confirm a new account. After signing in you choose to
create a workspace (pick a kind of business, then its details) or join one with a code. To try
roles, make a code in Settings → Join codes and sign up a second account to use it.

Money is stored as whole centavos everywhere (₱1,234.50 is `123450`). Posted records can't be
changed, even directly in the database; see [migration 0002](apps/api/src/db/migrations/0002_posted_records_are_final.sql).

The phone app, in a third terminal (needs Expo Go on a phone, or a simulator):

```sh
npm run dev:mobile
```

On a real phone, set `EXPO_PUBLIC_API_URL` to your computer's address on the Wi-Fi network; see
[apps/mobile/src/config.ts](apps/mobile/src/config.ts).

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
