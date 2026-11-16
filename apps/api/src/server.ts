import { buildApp } from './app.ts'
import { config } from './config.ts'
import { pool, runMigrations } from './db/client.ts'
import { startDemoJobs } from './features/demo/routes.ts'
import { checkMail } from './lib/mailer.ts'

try {
  await runMigrations()
} catch (e) {
  const err = e as Error & { code?: string; cause?: { code?: string } }
  const offline = [err.code, err.cause?.code].some((c) => c === 'ECONNREFUSED' || c === 'ENOTFOUND')
  if (offline) console.error(`Can't reach the database at ${config.DATABASE_URL.replace(/:[^:@/]*@/, ':•••@')}.\nIs it running? Start it with: npm run db:up`)
  else console.error('Couldn’t update the database:', err.message)
  process.exit(1)
}

const app = await buildApp()
// "Try the demo": keeps a spare built, and wipes demos nightly (hooks must be added before listening)
startDemoJobs(app)
try {
  await app.listen({ host: config.HOST, port: config.PORT })
} catch (e) {
  if ((e as { code?: string }).code !== 'EADDRINUSE') throw e
  console.error(`Port ${config.PORT} is already in use: another copy of the API is probably running. Find it with: lsof -i :${config.PORT}`)
  await pool.end()
  process.exit(1)
}

const mail = await checkMail()
if (mail.via === 'console') app.log.info('No BREVO_API_KEY or SMTP_URL: emails, including confirmation links, are printed in this terminal.')
else if (mail.ok) app.log.info(`Email: sending through ${mail.via === 'brevo' ? 'Brevo' : 'SMTP'} as ${config.mailFrom.email}.`)
else app.log.error(`Email: ${mail.detail}\n  Check ${mail.via === 'brevo' ? 'BREVO_API_KEY / MAIL_FROM' : 'SMTP_URL'} in .env. Until then, emails fail.`)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    await app.close()
    await pool.end()
    process.exit(0)
  })
}
