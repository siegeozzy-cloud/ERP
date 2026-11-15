# ERP

A multi-tenant ERP for Philippine businesses, on the web and on phones. People join a workspace with a
one-time code or create one from a template made for their kind of business.

**Status:** Phase 0 (foundations) is done. See [docs/roadmap.md](docs/roadmap.md).

- [docs/plan.md](docs/plan.md): tech stack, free services, user flow, modules, niche templates,
  Philippine compliance
- [docs/roadmap.md](docs/roadmap.md): build phases and the investor demo milestone

## What's in the repo

| Folder | What it is |
| --- | --- |
| [`apps/api/`](apps/api/) | The API: Node + Fastify + PostgreSQL (Drizzle). Accounts, sessions, email links. |
| [`apps/web/`](apps/web/) | The web app: React + Vite + Tailwind + shadcn/ui, TanStack Router and Query. |
| [`apps/mobile/`](apps/mobile/) | The phone app: Expo (React Native). For now it only checks it can reach the API. |
| [`packages/shared/`](packages/shared/) | Validation rules and API types used by all three. |

## Run it locally

Needs Node 22.18 or newer (24 recommended, see `.nvmrc`) and Docker Desktop.

```sh
npm install
cp apps/api/.env.example apps/api/.env   # then set ENCRYPTION_KEY (the command is in the file)
npm run db:up                            # PostgreSQL on port 5433
```

Then, in two terminals:

```sh
npm run dev:api    # API on http://127.0.0.1:4100
npm run dev:web    # web app on http://127.0.0.1:5180
```

With no email service set up, confirmation and password-reset links are printed in the API's
terminal. Open the link from there to confirm a new account.

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
