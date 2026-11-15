import { defineConfig } from 'drizzle-kit'

// `npm run db:generate -w @erp/api` turns changes in src/db/schema.ts into a new SQL migration.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './src/db/migrations',
  casing: 'snake_case',
  dbCredentials: { url: process.env.DATABASE_URL ?? 'postgres://erp:erp@127.0.0.1:5433/erp' },
})
