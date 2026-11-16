# Putting the investor demo online

Three free services: **Neon** (database), **Render** (API), **Vercel** (web app), plus **Expo EAS**
for the Android APK. Each needs an account of yours; nothing here can be done from the repo alone.
Do them in this order, since each step needs the address from the one before.

## 1. Database: Neon

1. Create a project (region: Singapore, closest to the Philippines).
2. Copy the connection string (it ends in `?sslmode=require`).

The API creates the tables itself when it starts.

## 2. API: Render

1. New → **Blueprint** → this GitHub repository. Render reads [`render.yaml`](../render.yaml).
2. When it asks for the settings:
   - `DATABASE_URL`: Neon's connection string.
   - `ENCRYPTION_KEY`: make one with
     `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.
     **Keep a copy somewhere safe**: without it the encrypted ID numbers can't be read back.
   - `APP_URL`: the web app's address. You don't have it yet: put `https://example.com`, and change
     it after step 3.
   - `API_URL`: this service's address, shown at the top of its Render page (e.g.
     `https://erp-api-xxxx.onrender.com`).
3. Check `https://<api>/api/health` answers `{"ok":true,"db":true}`.

Free Render services sleep after 15 minutes without visitors, and the first request then takes
about a minute. **Open the app a few minutes before a pitch.** The API builds a demo business as
soon as it wakes, so the button is instant after that.

Optional: `BREVO_API_KEY` and `MAIL_FROM` for real sign-up emails (see `apps/api/.env.example`). The
demo doesn't need email.

## 3. Web app: Vercel

1. Add New → Project → this repository. **Root directory: `apps/web`.** Vercel detects Vite.
2. Environment variable: `VITE_API_URL` = the Render address from step 2.
3. Deploy, then put the Vercel address in Render's `APP_URL` (Render restarts the API).

The link to share is `https://<web>/demo`: it opens a demo straight away. `https://<web>/` is the
landing page (with a "Try the demo" button), and the sign-in page has one too.

`vercel.json` sets the web app's security headers. Its CSP allows the app to call any `https:`
address; once the API has its own domain, narrow `connect-src` to it.

## 4. Android APK: Expo EAS

From `apps/mobile`:

```sh
npx eas-cli login
npx eas-cli init                      # links the app to an Expo project (once)
npx eas-cli env:create --environment preview --name EXPO_PUBLIC_API_URL --value https://<api> --visibility plaintext
npx eas-cli build --platform android --profile preview
```

The build runs on Expo's servers (free tier: a limited number a month) and ends with a link to
download the `.apk`. Send that link, or the file, to anyone with an Android phone; they allow
"install from unknown sources" once. iPhones need TestFlight (a paid Apple account), so for now
show iPhone users the web app.

## How the demo works

- Each "Try the demo" gets its **own copy** of Sariwa Food Supply Co., signed in as Carmela, the
  owner. Nobody sees anyone else's changes.
- A spare copy is kept ready (`DEMO_SPARES`, default 1). Building one takes 15–60 seconds.
- Copies are deleted at **3 a.m. Manila time** (always after at least 12 hours). At most
  `DEMO_MAX_ACTIVE` (default 40) exist at once, to stay inside Neon's free 0.5 GB.
- The yellow bar at the top shows the email and password that open the same copy in the phone
  app: clock in on the phone, and it shows on the web's HR page.
- `DEMO=off` turns it all off.

**A 3-minute pitch path:** Dashboard → Inventory (stock by lot, write off the expired eggs → see
Spoilage in Finance) → Sales & CRM (pipeline; deliver the half-delivered hotel order; invoice it) →
Manufacturing (complete the chocolate premix work order with its QC checks; the plan says what to buy) → Projects (the cold room expansion's Gantt chart and job cost; bill the hotel's hours) → Finance (overdue invoices, BIR reports) → HR (approve leave on the phone, run this period's
payroll, see payslips arrive on the phone).
