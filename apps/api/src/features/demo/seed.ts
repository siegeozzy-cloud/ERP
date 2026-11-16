import { randomBytes } from 'node:crypto'
import { hash } from '@node-rs/argon2'
import { DEMO_TEMPLATE, type Account, type Contact, type Employee, type Invoice, type LeadDetail, type PayrollRun, type Quote, type Role, type SalesOrder, type TaxCode, type TrialBalance, type Unit, type WorkOrder } from '@erp/shared'
import { and, eq, inArray, like, lt, or, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { db } from '../../db/client.ts'
import { demoAccounts, holidays, memberships, sessions, timeEntries, users, workspaces } from '../../db/schema.ts'
import { hashToken, newToken } from '../../lib/crypto.ts'
import { todayInManila } from '../finance/ledger.ts'
import { addDays, daysBetween, fromManila, monthEnd, weekday } from '../hr/time.ts'

/**
 * The "Try the demo" business: Sariwa Food Supply Co., a food distributor in Quezon City selling
 * flour, sugar, dairy, eggs and frozen chicken to bakeries, cafés, restaurants, a hotel and a caterer.
 * Every name in it is made up.
 *
 * It's built the way a real one would be: through the API, as the people who'd do each job (the
 * owner issues purchase orders, the warehouse receives and delivers, sales takes orders, the
 * accountant posts and pays, HR runs payroll), so the books, the stock and the audit log are exactly
 * what the app itself produces. Only clock-ins are written straight to the table, since there are
 * hundreds of them.
 *
 * The story covers the last two to three months, ending yesterday: opening balances, two rounds of
 * buying, around two dozen orders, spoilage written off, payroll posted and paid with the government
 * contributions remitted, a pipeline of leads, and a few things left for the visitor to do (leave
 * to approve, an order to deliver, an expired lot to write off, this period's payroll to run).
 *
 * Random choices come from a fixed seed, so every demo tells the same story.
 */

const SEED_HEADER = 'x-demo-seed'
/** Requests from the builder skip the rate limits (it makes hundreds), and only it knows this. */
export const seedSecret = newToken()
export const isSeedRequest = (headers: Record<string, unknown>) => headers[SEED_HEADER] === seedSecret

/** A password nobody knows, for the demo's staff accounts (made once). */
let lockedHash: Promise<string> | null = null

// A small deterministic PRNG (mulberry32).
function prng(seed: number) {
  let a = seed
  const next = () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
  return { next, int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)), chance: (p: number) => next() < p }
}

/** A valid EAN-13 from a 12-digit body (480 is the Philippine prefix; the rest is made up). */
function ean13(body: string) {
  const sum = [...body].reduce((s, d, i) => s + Number(d) * (i % 2 ? 3 : 1), 0)
  return body + ((10 - (sum % 10)) % 10)
}

const peso = (p: number) => Math.round(p * 100)

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
// The API's answers are typed at each call; `any` here keeps the builder short.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any

type Actor = { id: string; name: string; call: <T = Json>(method: Method, url: string, body?: object) => Promise<T> }

type ItemSpec = {
  sku: string
  name: string
  unit: string
  cost: number
  price: number
  store: 'main' | 'cold'
  /** Days from receipt (or making) to expiry. */
  life: number
  lot: string
  /** Bought by the piece, no lots (packaging). */
  lots?: false
  /** Made here (Phase 6): a batch, its components, the routing at work centres, and the QC checks. */
  made?: { batch: number; lines: [string, number][]; ops: ['BLEND' | 'PACK', string, number][]; qc: string[] }
}

const PREMIX_QC = ['Each bag 25 kg ± 100 g', 'Moisture under 14%', 'Bag sealed and labelled with lot and best-before date']
const MADE = ['PREMIX-PANDESAL', 'PREMIX-CHOCO']

const ITEMS: ItemSpec[] = [
  { sku: 'FLOUR-AP25', name: 'All-purpose flour, 25 kg', unit: 'sack', cost: 1_020, price: 1_320, store: 'main', life: 270, lot: 'AP' },
  { sku: 'FLOUR-BR25', name: 'Bread flour, 25 kg', unit: 'sack', cost: 1_120, price: 1_450, store: 'main', life: 270, lot: 'BR' },
  { sku: 'YEAST-500', name: 'Instant dry yeast, 500 g', unit: 'pack', cost: 150, price: 198, store: 'main', life: 365, lot: 'YS' },
  { sku: 'SUGAR-50', name: 'Refined sugar, 50 kg', unit: 'sack', cost: 3_250, price: 4_050, store: 'main', life: 540, lot: 'SG' },
  { sku: 'COCOA-1KG', name: 'Cocoa powder, 1 kg', unit: 'pack', cost: 410, price: 545, store: 'main', life: 365, lot: 'CC' },
  { sku: 'CREAM-12L', name: 'All-purpose cream, 12 × 1 L', unit: 'case', cost: 1_540, price: 1_960, store: 'main', life: 180, lot: 'CR' },
  { sku: 'MILK-EVAP48', name: 'Evaporated milk, 48 × 370 mL', unit: 'case', cost: 1_720, price: 2_160, store: 'main', life: 365, lot: 'EV' },
  { sku: 'OIL-18L', name: 'Cooking oil, 18 L', unit: 'pail', cost: 1_420, price: 1_790, store: 'main', life: 365, lot: 'OL' },
  { sku: 'BUTTER-5KG', name: 'Unsalted butter, 5 kg block', unit: 'pc', cost: 1_880, price: 2_420, store: 'cold', life: 150, lot: 'BT' },
  { sku: 'CHEESE-2KG', name: 'Cheddar cheese, 2 kg loaf', unit: 'pc', cost: 760, price: 990, store: 'cold', life: 120, lot: 'CH' },
  { sku: 'EGGS-30', name: 'Eggs, large, tray of 30', unit: 'tray', cost: 215, price: 268, store: 'cold', life: 21, lot: 'EG' },
  { sku: 'CHICKEN-KG', name: 'Whole chicken, frozen', unit: 'kg', cost: 168, price: 214, store: 'cold', life: 180, lot: 'CK' },
  { sku: 'BAG-PREMIX', name: 'Printed premix bag, 25 kg', unit: 'pc', cost: 18, price: 0, store: 'main', life: 3650, lot: 'BG', lots: false },
  // blended here: a batch is 20 bags of 25 kg
  {
    sku: 'PREMIX-PANDESAL',
    name: 'Pandesal premix, 25 kg',
    unit: 'sack',
    cost: 1_335,
    price: 1_690,
    store: 'main',
    life: 120,
    lot: 'PP',
    made: {
      batch: 20,
      lines: [['FLOUR-BR25', 17], ['SUGAR-50', 1], ['YEAST-500', 20], ['BAG-PREMIX', 20]],
      ops: [['BLEND', 'Sift and blend 15 minutes', 90], ['PACK', 'Weigh, fill, seal and label', 60]],
      qc: PREMIX_QC,
    },
  },
  {
    sku: 'PREMIX-CHOCO',
    name: 'Chocolate cake premix, 25 kg',
    unit: 'sack',
    cost: 2_145,
    price: 2_690,
    store: 'main',
    life: 150,
    lot: 'PC',
    made: {
      batch: 20,
      lines: [['FLOUR-AP25', 15], ['SUGAR-50', 3], ['COCOA-1KG', 40], ['BAG-PREMIX', 20]],
      ops: [['BLEND', 'Sift cocoa, blend 20 minutes', 100], ['PACK', 'Weigh, fill, seal and label', 60]],
      qc: PREMIX_QC,
    },
  },
]

const SUPPLIERS = {
  flour: { name: 'Gintong Butil Flour Mills Inc.', tin: '204-511-873-00000', address: 'Km. 21 Aguinaldo Highway, Imus, Cavite', items: ['FLOUR-AP25', 'FLOUR-BR25', 'YEAST-500'] },
  sugar: { name: 'Tamis Sugar Trading Corp.', tin: '205-338-910-00000', address: 'Araneta Street, Bacolod City, Negros Occidental', items: ['SUGAR-50', 'COCOA-1KG'] },
  dairy: { name: 'Luntiang Pastulan Dairy Cooperative', tin: '206-774-215-00000', address: 'Brgy. San Jose, Lipa City, Batangas', items: ['BUTTER-5KG', 'CHEESE-2KG', 'CREAM-12L', 'MILK-EVAP48'] },
  poultry: { name: 'Bukid Fresh Poultry Farms', tin: '207-102-648-00000', address: 'Brgy. Sto. Cristo, San Jose del Monte, Bulacan', items: ['EGGS-30', 'CHICKEN-KG'] },
  oils: { name: 'Tanglaw Oils & Commodities Inc.', tin: '208-930-457-00000', address: 'Pier 4, North Harbor, Tondo, Manila', items: ['OIL-18L'] },
  packaging: { name: 'Pak-Ayos Packaging Corp.', tin: '212-480-331-00000', address: 'Canumay, Valenzuela City', items: ['BAG-PREMIX'] },
} as const
type SupplierKey = keyof typeof SUPPLIERS

type CustomerSpec = { key: string; name: string; tin: string; address: string; phone: string; terms: number; limit: number; withholds?: boolean; basket: [string, number, number][] }

const CUSTOMERS: CustomerSpec[] = [
  {
    key: 'bakery',
    name: 'Panaderia de Sta. Cruz',
    tin: '301-245-778-00000',
    address: '1123 Rizal Avenue, Sta. Cruz, Manila',
    phone: '0917 820 4410',
    terms: 15,
    limit: 1_500_000,
    basket: [['FLOUR-AP25', 8, 14], ['FLOUR-BR25', 5, 9], ['SUGAR-50', 2, 3], ['YEAST-500', 10, 18], ['BUTTER-5KG', 2, 5], ['EGGS-30', 10, 18], ['PREMIX-PANDESAL', 4, 8]],
  },
  {
    key: 'ensaymada',
    name: 'Sweet Ensaymada Bakeshop',
    tin: '302-617-904-00000',
    address: '45 Kalayaan Avenue, Diliman, Quezon City',
    phone: '0918 334 1290',
    terms: 15,
    limit: 800_000,
    basket: [['FLOUR-AP25', 4, 7], ['SUGAR-50', 1, 2], ['BUTTER-5KG', 3, 6], ['CHEESE-2KG', 3, 6], ['EGGS-30', 8, 14], ['PREMIX-CHOCO', 2, 4], ['PREMIX-PANDESAL', 2, 4]],
  },
  {
    key: 'cafe',
    name: 'Café Kalye Inc.',
    tin: '303-882-156-00000',
    address: 'G/F 88 Maginhawa Street, Teachers Village, Quezon City',
    phone: '0927 551 7023',
    terms: 30,
    limit: 900_000,
    basket: [['CREAM-12L', 3, 5], ['MILK-EVAP48', 2, 3], ['COCOA-1KG', 5, 9], ['CHEESE-2KG', 2, 5], ['BUTTER-5KG', 1, 2]],
  },
  {
    key: 'resto',
    name: 'Lutong Bahay Restaurant',
    tin: '304-509-331-00000',
    address: '17 Tomas Morato Avenue, Quezon City',
    phone: '0916 702 3348',
    terms: 7,
    limit: 800_000,
    basket: [['CHICKEN-KG', 40, 70], ['OIL-18L', 2, 4], ['EGGS-30', 5, 9]],
  },
  {
    key: 'hotel',
    name: 'Hotel Marilag Manila Inc.',
    tin: '305-118-640-00000',
    address: '1588 Roxas Boulevard, Malate, Manila',
    phone: '(02) 8521 3300',
    terms: 30,
    limit: 3_000_000,
    withholds: true,
    basket: [['CHICKEN-KG', 60, 110], ['EGGS-30', 20, 35], ['BUTTER-5KG', 3, 5], ['CHEESE-2KG', 4, 7], ['CREAM-12L', 3, 6], ['MILK-EVAP48', 2, 4], ['OIL-18L', 2, 4]],
  },
  {
    key: 'caterer',
    name: 'Kusina ni Lola Catering Services',
    tin: '306-473-209-00000',
    address: '9 Sampaguita Street, Marikina Heights, Marikina City',
    phone: '0945 118 6620',
    terms: 15,
    limit: 900_000,
    basket: [['CHICKEN-KG', 50, 90], ['OIL-18L', 2, 4], ['CREAM-12L', 2, 3], ['SUGAR-50', 1, 1]],
  },
]

type PersonSpec = {
  key: 'owner' | 'ramon' | 'liza' | 'jomar' | 'patricia' | 'arnel' | 'efren' | 'rowena' | 'dennis'
  firstName: string
  lastName: string
  position: string
  department: string
  hireDate: string
  payBasis: 'monthly' | 'daily'
  rate: number
  minimumWageEarner?: boolean
  tracksAttendance: boolean
  shiftStart?: string
  restDays?: number[]
  workDaysPerYear?: number
  ids: { tin: string; sssNo: string; philhealthNo: string; pagibigNo: string }
  role?: string
}

const PEOPLE: PersonSpec[] = [
  { key: 'owner', firstName: 'Carmela', lastName: 'Santos', position: 'General manager', department: 'Management', hireDate: '2019-03-01', payBasis: 'monthly', rate: 85_000, tracksAttendance: false, ids: { tin: '123-456-781-00000', sssNo: '34-5512870-1', philhealthNo: '12-050318722-4', pagibigNo: '1211-4408-1923' } },
  { key: 'ramon', firstName: 'Ramon', lastName: 'Dizon', position: 'Accountant', department: 'Finance', hireDate: '2021-06-14', payBasis: 'monthly', rate: 38_000, tracksAttendance: false, role: 'Accountant', ids: { tin: '231-874-502-00000', sssNo: '33-9871204-6', philhealthNo: '12-201447890-1', pagibigNo: '1210-7733-0458' } },
  { key: 'liza', firstName: 'Liza', lastName: 'Manalo', position: 'HR and payroll officer', department: 'Administration', hireDate: '2022-01-10', payBasis: 'monthly', rate: 30_000, tracksAttendance: false, role: 'HR & payroll', ids: { tin: '312-650-847-00000', sssNo: '34-2209137-5', philhealthNo: '12-310558204-9', pagibigNo: '1212-0915-6637' } },
  { key: 'patricia', firstName: 'Patricia', lastName: 'Lim', position: 'Account executive', department: 'Sales', hireDate: '2023-08-01', payBasis: 'monthly', rate: 26_000, tracksAttendance: true, role: 'Sales', ids: { tin: '420-118-395-00000', sssNo: '35-1048226-3', philhealthNo: '12-415093312-7', pagibigNo: '1213-5820-4471' } },
  { key: 'jomar', firstName: 'Jomar', lastName: 'Bautista', position: 'Warehouse lead', department: 'Warehouse', hireDate: '2020-11-03', payBasis: 'daily', rate: 790, tracksAttendance: true, workDaysPerYear: 313, role: 'Warehouse staff', ids: { tin: '508-231-764-00000', sssNo: '33-6610482-9', philhealthNo: '12-118874063-2', pagibigNo: '1210-3366-2290' } },
  { key: 'arnel', firstName: 'Arnel', lastName: 'Reyes', position: 'Production lead (premix room)', department: 'Production', hireDate: '2022-07-18', payBasis: 'daily', rate: 810, tracksAttendance: true, workDaysPerYear: 313, role: 'Production staff', ids: { tin: '903-118-472-00000', sssNo: '34-6629158-7', philhealthNo: '12-604417390-5', pagibigNo: '1212-8841-2276' } },
  { key: 'efren', firstName: 'Efren', lastName: 'Pascual', position: 'Delivery driver', department: 'Logistics', hireDate: '2021-02-15', payBasis: 'daily', rate: 755, minimumWageEarner: true, tracksAttendance: true, workDaysPerYear: 313, ids: { tin: '611-905-238-00000', sssNo: '34-8834017-2', philhealthNo: '12-220691145-8', pagibigNo: '1211-9047-5512' } },
  { key: 'rowena', firstName: 'Rowena', lastName: 'Castro', position: 'Warehouse helper', department: 'Warehouse', hireDate: '2024-04-08', payBasis: 'daily', rate: 755, minimumWageEarner: true, tracksAttendance: true, workDaysPerYear: 313, ids: { tin: '702-448-913-00000', sssNo: '35-4472915-0', philhealthNo: '12-507216638-3', pagibigNo: '1213-2281-0954' } },
  { key: 'dennis', firstName: 'Dennis', lastName: 'Ocampo', position: 'Cold room checker (afternoon shift)', department: 'Warehouse', hireDate: '2023-02-20', payBasis: 'daily', rate: 820, tracksAttendance: true, shiftStart: '14:00', workDaysPerYear: 313, ids: { tin: '815-372-604-00000', sssNo: '34-0927736-4', philhealthNo: '12-330918457-6', pagibigNo: '1212-6640-3318' } },
]

/** Customers' usual orders, times this, make a business of about ₱2.5 million in sales a month. */
const SCALE = 3.5
/** Orders on an open day, on average (see the day-by-day loop). */
const ORDERS_PER_DAY = 1.1

/** What each item sells in a week, from the customers' usual orders: reorder points and buying follow it. */
const WEEKLY: Record<string, number> = Object.fromEntries(ITEMS.map((i) => [i.sku, 0]))
for (const c of CUSTOMERS) {
  for (const [i, [sku, lo, hi]] of c.basket.entries()) WEEKLY[sku]! += ((i < 2 ? 1 : 0.65) * ((lo + hi) / 2) * SCALE * ORDERS_PER_DAY * 6) / CUSTOMERS.length
}
// what production uses counts too: buying follows it
for (const it of ITEMS) for (const [sku, q] of it.made?.lines ?? []) WEEKLY[sku]! += (WEEKLY[it.sku]! * q) / it.made!.batch
const roundUp = (n: number, step: number) => Math.ceil(n / step) * step
const stepOf = (sku: string) => (sku === 'CHICKEN-KG' ? 50 : 10)

/** Every account a demo makes is at this address (example.com is reserved: it never reaches anyone). */
export const DEMO_EMAIL_DOMAIN = 'demo.example.com'

/** The business name, also the workspace name. */
export const DEMO_BUSINESS = 'Sariwa Food Supply Co.'

/** What a built demo is: its owner (the visitor, once claimed) and the workspace. */
export type BuiltDemo = { userId: string; workspaceId: string }

/**
 * Builds one demo business and returns it, unclaimed. A `demo_accounts` row exists from the moment
 * the workspace does, so a build that fails halfway is still found and cleaned up.
 */
export async function buildDemo(app: FastifyInstance): Promise<BuiltDemo> {
  const tag = randomBytes(5).toString('hex')
  lockedHash ??= hash(newToken())
  const passwordHash = await lockedHash
  const rnd = prng(20_261_116)

  const T = todayInManila()
  /** The story starts on the 1st, two months back: 61 to 92 days of history. */
  const S = (() => {
    const d = new Date(`${T.slice(0, 7)}-01T00:00:00Z`)
    d.setUTCMonth(d.getUTCMonth() - 2)
    return d.toISOString().slice(0, 10)
  })()
  const d = (n: number) => addDays(S, n)
  const ago = (n: number) => addDays(T, -n)
  const sessionIds: string[] = []

  /* ---------- people who sign in ---------- */

  async function makeActor(key: string, name: string): Promise<Actor> {
    const email = key === 'owner' ? `demo-${tag}@${DEMO_EMAIL_DOMAIN}` : `${key}.${tag}@${DEMO_EMAIL_DOMAIN}`
    const [user] = await db.insert(users).values({ email, name, passwordHash, emailVerifiedAt: new Date(), termsAcceptedAt: new Date() }).returning()
    const token = newToken()
    sessionIds.push(hashToken(token))
    await db.insert(sessions).values({ id: hashToken(token), userId: user!.id, remember: false, expiresAt: new Date(Date.now() + 3_600_000) })
    return {
      id: user!.id,
      name,
      async call(method, url, body) {
        const r = await app.inject({ method, url, payload: body, headers: { authorization: `Bearer ${token}`, [SEED_HEADER]: seedSecret } })
        if (r.statusCode >= 300) throw new Error(`Demo builder: ${name} ${method} ${url} → ${r.statusCode} ${r.body.slice(0, 400)}`)
        return (r.body ? r.json() : undefined) as never
      },
    }
  }

  const people = Object.fromEntries(PEOPLE.map((p) => [p.key, p])) as Record<PersonSpec['key'], PersonSpec>
  const owner = await makeActor('owner', `${people.owner.firstName} ${people.owner.lastName}`)

  let ws = ''
  const w = (p: string) => `/api/w/${ws}${p}`
  try {
    ws = (
      await owner.call<{ workspace: { id: string } }>('POST', '/api/workspaces', {
        template: DEMO_TEMPLATE,
        name: DEMO_BUSINESS,
        tin: '010-234-567-00000',
        vatStatus: 'vat',
        street: '18 Mindanao Avenue, Brgy. Bahay Toro, Quezon City, Metro Manila',
      })
    ).workspace.id
  } catch (e) {
    await db.delete(users).where(eq(users.id, owner.id))
    throw e
  }
  await db.insert(demoAccounts).values({ userId: owner.id, workspaceId: ws })

  try {
    await owner.call('PATCH', w(''), {
      name: DEMO_BUSINESS,
      tin: '010-234-567-00000',
      vatStatus: 'vat',
      street: '18 Mindanao Avenue, Brgy. Bahay Toro, Quezon City, Metro Manila',
      fiscalYearStartMonth: 1,
      modules: ['finance', 'inventory', 'crm', 'hr', 'manufacturing', 'projects'],
      dpoName: 'Liza Manalo',
      dpoEmail: `privacy.${tag}@${DEMO_EMAIL_DOMAIN}`,
    })

    // the staff join with codes, as real people would
    const roles = (await owner.call<{ roles: Role[] }>('GET', w('/roles'))).roles
    const staff = {} as Record<'ramon' | 'liza' | 'jomar' | 'patricia' | 'arnel', Actor>
    for (const key of ['ramon', 'liza', 'jomar', 'patricia', 'arnel'] as const) {
      const p = people[key]
      const code = (await owner.call('POST', w('/join-codes'), { roleId: roles.find((r) => r.name === p.role)!.id })).code.code as string
      const actor = await makeActor(key, `${p.firstName} ${p.lastName}`)
      await actor.call('POST', '/api/workspaces/join', { code })
      staff[key] = actor
    }
    const { ramon, liza, jomar, patricia, arnel } = staff

    /* ---------- the setup ---------- */

    const acct: Record<string, string> = {}
    for (const a of (await owner.call<{ accounts: Account[] }>('GET', w('/accounts'))).accounts) {
      acct[a.code] = a.id
      if (a.systemKey) acct[a.systemKey] = a.id
    }
    const tax: Record<string, string> = {}
    for (const t of (await owner.call<{ taxCodes: TaxCode[] }>('GET', w('/tax-codes'))).taxCodes) tax[t.code] = t.id
    const unit: Record<string, string> = {}
    for (const u of (await owner.call<{ units: Unit[] }>('GET', w('/units'))).units) unit[u.code] = u.id

    const warehouses = (await owner.call<{ warehouses: { id: string }[] }>('GET', w('/warehouses'))).warehouses
    const store = {
      main: warehouses[0]!.id,
      cold: (await owner.call('POST', w('/warehouses'), { code: 'COLD', name: 'Cold room', address: 'Same compound, Building B' })).warehouse.id as string,
    }
    await owner.call('PUT', w(`/warehouses/${store.main}`), { code: 'MAIN', name: 'Main warehouse', address: '18 Mindanao Avenue, Quezon City', active: true })

    const supplier = {} as Record<SupplierKey | 'rent' | 'power' | 'trucking', string>
    for (const [key, s] of Object.entries(SUPPLIERS)) {
      supplier[key as SupplierKey] = (await ramon.call('POST', w('/contacts'), { name: s.name, tin: s.tin, address: s.address, isSupplier: true })).contact.id
    }
    supplier.rent = (await ramon.call('POST', w('/contacts'), { name: 'Mabuhay Realty Corp.', tin: '209-660-118-00000', address: 'Ortigas Center, Pasig City', isSupplier: true, defaultEwtCodeId: tax.WC100 })).contact.id
    supplier.power = (await ramon.call('POST', w('/contacts'), { name: 'Liwanag Power & Light Co.', tin: '210-447-902-00000', address: 'Ortigas Avenue, Pasig City', isSupplier: true })).contact.id
    supplier.trucking = (await ramon.call('POST', w('/contacts'), { name: 'Ka-Ruta Logistics', tin: '211-338-574-00000', address: 'Valenzuela City', isSupplier: true, defaultEwtCodeId: tax.WC120 })).contact.id

    const customer: Record<string, string> = {}
    for (const c of CUSTOMERS) {
      customer[c.key] = (
        await ramon.call<{ contact: Contact }>('POST', w('/contacts'), { name: c.name, tin: c.tin, address: c.address, phone: c.phone, isCustomer: true, paymentTermsDays: c.terms, creditLimit: peso(c.limit) })
      ).contact.id
    }
    customer.walkin = (await ramon.call('POST', w('/contacts'), { name: 'Cash sales (walk-in)', isCustomer: true, paymentTermsDays: 0 })).contact.id
    const terms = Object.fromEntries([...CUSTOMERS.map((c) => [c.key, c.terms] as const), ['walkin', 0] as const])

    const item: Record<string, string> = {}
    const spec: Record<string, ItemSpec> = {}
    for (const [i, it] of ITEMS.entries()) {
      spec[it.sku] = it
      item[it.sku] = (
        await owner.call('POST', w('/items'), {
          sku: it.sku,
          name: it.name,
          unitId: unit[it.unit],
          barcode: ean13(`48012345${String(100 + i * 7).padStart(4, '0')}`),
          salesPrice: peso(it.price),
          purchaseCost: peso(it.cost),
          trackLots: it.lots !== false,
          trackExpiry: it.lots !== false,
          // a week's sales; buy two weeks' worth
          reorderPoint: roundUp(WEEKLY[it.sku]!, stepOf(it.sku)),
          reorderQty: roundUp(WEEKLY[it.sku]! * 2, stepOf(it.sku)),
        })
      ).item.id
    }
    const delivery = (await owner.call('POST', w('/items'), { sku: 'DELIVERY', name: 'Delivery fee', kind: 'service', unitId: unit.pc, salesPrice: peso(350) })).item.id as string

    // the premix room: two work centres, and a bill of materials for each premix
    const wc = {
      BLEND: (await arnel.call('POST', w('/work-centers'), { code: 'BLEND', name: 'Blending room', costPerHour: peso(480) })).workCenter.id as string,
      PACK: (await arnel.call('POST', w('/work-centers'), { code: 'PACK', name: 'Packing line', costPerHour: peso(320) })).workCenter.id as string,
    }
    for (const sku of MADE) {
      const m = spec[sku]!.made!
      await arnel.call('POST', w('/boms'), {
        itemId: item[sku],
        outputQty: m.batch,
        notes: 'Allergens: wheat (gluten). Store dry, off the floor, below 30 °C.',
        lines: m.lines.map(([c, quantity]) => ({ itemId: item[c], quantity })),
        operations: m.ops.map(([centre, description, minutes]) => ({ workCenterId: wc[centre], description, minutes })),
        qcChecks: m.qc,
      })
    }

    /* ---------- opening balances: the owner's capital, a bank loan, and the stock on hand ---------- */

    const opening = await ramon.call('POST', w('/journal'), {
      date: d(0),
      memo: 'Opening balances',
      lines: [
        { accountId: acct.bank, debit: peso(5_950_000), description: 'Cash in bank' },
        { accountId: acct.cash, debit: peso(50_000), description: 'Petty cash' },
        { accountId: acct['3000'], credit: peso(3_500_000), description: 'Owner’s capital' },
        { accountId: acct['2300'], credit: peso(2_500_000), description: 'Working capital loan, 3 years' },
      ],
    })
    await ramon.call('POST', w(`/journal/${opening.entry.id}/post`))

    /**
     * The builder keeps its own copy of the stock, lot by lot, with the same rules as the app (the lot
     * that expires first goes first, expired lots don't sell), so it never asks for more than is there.
     */
    type Lot = { lotNo: string; expiry: string; qty: number }
    const stock: Record<string, Lot[]> = Object.fromEntries(ITEMS.map((i) => [i.sku, []]))
    const fefo = (sku: string) => stock[sku]!.filter((l) => l.qty > 0).sort((a, b) => (a.expiry === b.expiry ? (a.lotNo < b.lotNo ? -1 : 1) : a.expiry < b.expiry ? -1 : 1))
    const sellable = (sku: string, date: string) => fefo(sku).reduce((s, l) => s + (l.expiry >= date ? l.qty : 0), 0)
    function take(sku: string, qty: number, date: string) {
      let left = qty
      for (const l of fefo(sku)) {
        if (left <= 0) break
        if (l.expiry < date) continue
        const n = Math.min(l.qty, left)
        l.qty -= n
        left -= n
      }
      if (left > 0) throw new Error(`Demo builder: ran out of ${sku} on ${date}`)
    }
    const lotNo = (sku: string, date: string) => `${spec[sku]!.lot}-${date.slice(5, 7)}${date.slice(8, 10)}`

    const openingStock = ITEMS.map((it) => ({ it, qty: Math.ceil((WEEKLY[it.sku]! * (it.life < 30 ? 1.2 : 2)) / 10) * 10, left: Math.min(it.life - 10, 200) }))
    for (const where of ['main', 'cold'] as const) {
      const here = openingStock.filter((o) => o.it.store === where)
      await jomar.call('POST', w('/stock/adjustments'), {
        date: d(0),
        warehouseId: store[where],
        reason: 'opening',
        notes: 'Stock on hand when the books were opened',
        lines: here.map(({ it, qty, left }) => ({ itemId: item[it.sku], change: qty, unitCost: peso(Math.round(it.cost * 0.98)), lotNo: `${it.lot}-OPEN`, expiryDate: d(left) })),
      })
      for (const { it, qty, left } of here) stock[it.sku]!.push({ lotNo: `${it.lot}-OPEN`, expiry: d(left), qty })
    }

    /* ---------- buying: purchase order → receipt → bill → payment ---------- */

    const billsToPay: { id: string; amount: number; payDay: string }[] = []

    async function purchase(key: SupplierKey, date: string, lines: [string, number][], o: { receive?: string; bill?: string; billPrice?: Record<string, number> }) {
      const po = (
        await owner.call('POST', w('/purchase-orders'), {
          supplierId: supplier[key],
          date,
          expectedDate: o.receive ?? addDays(date, 2),
          warehouseId: store[spec[lines[0]![0]]!.store],
          lines: lines.map(([sku, qty]) => ({ itemId: item[sku], quantity: qty, unitCost: peso(spec[sku]!.cost), vat: 'vatable' })),
        })
      ).purchaseOrder
      const issued = (await owner.call('POST', w(`/purchase-orders/${po.id}/issue`))).purchaseOrder as { id: string; lines: { id: string; item: { id: string; sku: string } }[] }
      if (!o.receive) return
      // the goods go to where each item is kept
      for (const where of ['main', 'cold'] as const) {
        const here = issued.lines.filter((l) => spec[l.item.sku]!.store === where)
        if (!here.length) continue
        await jomar.call('POST', w(`/purchase-orders/${issued.id}/receive`), {
          date: o.receive,
          warehouseId: store[where],
          notes: where === 'cold' ? 'Checked in at 2–4 °C' : undefined,
          lines: here.map((l) => {
            const qty = lines.find(([s]) => s === l.item.sku)![1]
            const lot = { lotNo: lotNo(l.item.sku, o.receive!), expiry: addDays(o.receive!, spec[l.item.sku]!.life), qty }
            stock[l.item.sku]!.push(lot)
            return { poLineId: l.id, quantity: qty, lotNo: lot.lotNo, expiryDate: lot.expiry }
          }),
        })
      }
      if (!o.bill) return
      const { billId } = await ramon.call('POST', w(`/purchase-orders/${issued.id}/bill`))
      const bill = (await ramon.call('GET', w(`/bills/${billId}`))).bill as { lines: Json[] }
      await ramon.call('PUT', w(`/bills/${billId}`), {
        supplierId: supplier[key],
        supplierInvoiceNo: `SI-${o.bill.replace(/-/g, '').slice(2)}${rnd.int(10, 99)}`,
        date: o.bill,
        dueDate: addDays(o.bill, 30),
        lines: bill.lines.map((l) => {
          const sku = ITEMS.find((i) => item[i.sku] === l.itemId)!.sku
          return { description: l.description, quantity: l.quantity, unitPrice: o.billPrice?.[sku] ? peso(o.billPrice[sku]) : l.unitPrice, vat: l.vat, accountId: l.accountId, itemId: l.itemId, poLineId: l.poLineId }
        }),
      })
      const posted = (await ramon.call('POST', w(`/bills/${billId}/post`))).bill as { amountDue: number }
      billsToPay.push({ id: billId, amount: posted.amountDue, payDay: addDays(o.bill, rnd.int(14, 21)) })
    }

    /** Orders from a supplier what's needed to have `weeks` of stock on hand, when anything is short. */
    async function restock(key: SupplierKey, date: string, weeks: number, o: { receive: boolean; bill: boolean; billPrice?: Record<string, number> }) {
      const receive = addDays(date, 1)
      const lines: [string, number][] = []
      for (const sku of SUPPLIERS[key].items) {
        const step = stepOf(sku)
        const want = roundUp(WEEKLY[sku]! * weeks - sellable(sku, receive), step)
        if (want >= step) lines.push([sku, want])
      }
      if (lines.length) await purchase(key, date, lines, { receive: o.receive ? receive : undefined, bill: o.receive && o.bill ? addDays(receive, rnd.int(0, 2)) : undefined, billPrice: o.billPrice })
    }

    /* ---------- selling: order → delivery → invoice → payment ---------- */

    type Sale = { cust: string; date: string; lines: [string, number][]; fee?: boolean; deliver?: 'all' | 'part' | 'none'; confirm?: boolean; pay?: 'on-time' | 'late' | 'no'; po?: string }
    const invoicesToPay: { id: string; amount: number; withheld: number; payDay: string; cust: string }[] = []

    async function sell(s: Sale) {
      const lines = s.lines.map(([sku, want]): [string, number] => [sku, Math.min(want, Math.floor(sellable(sku, s.date)))]).filter(([, q]) => q > 0)
      if (!lines.length) return
      const order = (
        await patricia.call<{ salesOrder: SalesOrder }>('POST', w('/sales-orders'), {
          customerId: customer[s.cust],
          date: s.date,
          deliveryDate: s.deliver === 'none' ? addDays(s.date, 2) : s.date,
          warehouseId: store[spec[lines[0]![0]]!.store],
          customerPoNo: s.po ?? (s.cust === 'hotel' || s.cust === 'cafe' ? `PO-${s.date.replace(/-/g, '').slice(2)}-${rnd.int(10, 99)}` : undefined),
          lines: [
            ...lines.map(([sku, qty]) => ({ itemId: item[sku], quantity: qty, unitPrice: peso(spec[sku]!.price), vat: 'vatable' })),
            ...(s.fee ? [{ itemId: delivery, quantity: 1, unitPrice: peso(350), vat: 'vatable' }] : []),
          ],
        })
      ).salesOrder
      if (s.confirm === false) return
      const confirmed = (await patricia.call<{ salesOrder: SalesOrder }>('POST', w(`/sales-orders/${order.id}/confirm`))).salesOrder
      if (s.deliver === 'none') return
      for (const where of ['main', 'cold'] as const) {
        const here = confirmed.lines.filter((l) => l.item.kind === 'stock' && spec[l.item.sku]!.store === where)
        if (!here.length) continue
        const out = here.map((l) => ({ soLineId: l.id, sku: l.item.sku, quantity: s.deliver === 'part' ? Math.ceil(l.quantity / 2) : l.quantity }))
        await jomar.call('POST', w(`/sales-orders/${order.id}/deliver`), {
          date: s.date,
          warehouseId: store[where],
          notes: where === 'cold' ? 'Loaded in the refrigerated van' : undefined,
          lines: out.map(({ soLineId, quantity }) => ({ soLineId, quantity })),
        })
        for (const l of out) take(l.sku, l.quantity, s.date)
      }
      const { invoiceId } = await ramon.call('POST', w(`/sales-orders/${order.id}/invoice`), { date: s.date })
      const inv = (await ramon.call<{ invoice: Invoice }>('POST', w(`/invoices/${invoiceId}/post`))).invoice
      if (s.pay === 'no') return
      const due = inv.dueDate ?? s.date
      const payDay = s.pay === 'late' ? addDays(due, rnd.int(4, 10)) : addDays(due, -rnd.int(0, Math.min(4, terms[s.cust]!)))
      const withheld = CUSTOMERS.find((c) => c.key === s.cust)?.withholds ? Math.round(inv.vatableAmount * 0.01) : 0
      invoicesToPay.push({ id: invoiceId, amount: inv.amountDue - withheld, withheld, payDay: payDay < s.date ? s.date : payDay, cust: s.cust })
    }

    /** A customer's usual order: their regular items, in their usual quantities. */
    function basket(cust: string): [string, number][] {
      const c = CUSTOMERS.find((x) => x.key === cust)!
      return c.basket.filter((_, i) => i < 2 || rnd.chance(0.65)).map(([sku, lo, hi]) => [sku, Math.round(rnd.int(lo, hi) * SCALE)])
    }

    /** A walk-in buying dry goods at the counter, paid in cash. */
    async function cashSale(date: string) {
      const lines = (['FLOUR-AP25', 'SUGAR-50', 'OIL-18L', 'MILK-EVAP48', 'YEAST-500'] as const)
        .filter(() => rnd.chance(0.5))
        .map((sku): [string, number] => [sku, Math.min(rnd.int(1, 4), Math.floor(sellable(sku, date)))])
        .filter(([, q]) => q > 0)
      if (!lines.length) return
      const draft = await ramon.call<{ invoice: Invoice }>('POST', w('/invoices'), {
        customerId: customer.walkin,
        warehouseId: store.main,
        date,
        dueDate: date,
        notes: 'Paid in cash at the counter',
        lines: lines.map(([sku, qty]) => ({ description: spec[sku]!.name, quantity: qty, unitPrice: peso(spec[sku]!.price), vat: 'vatable', accountId: acct.sales, itemId: item[sku] })),
      })
      const posted = (await ramon.call<{ invoice: Invoice }>('POST', w(`/invoices/${draft.invoice.id}/post`))).invoice
      for (const [sku, qty] of lines) take(sku, qty, date)
      await ramon.call('POST', w(`/invoices/${posted.id}/payments`), { date, accountId: acct.cash, amount: posted.amountDue, reference: 'Cash' })
    }

    /** Money in and out up to `day`: customers paying (the hotel withholds 1%, with a Form 2307), and suppliers paid. */
    async function settle(day: string) {
      for (const inv of invoicesToPay.splice(0)) {
        if (inv.payDay > day) {
          invoicesToPay.push(inv)
          continue
        }
        await ramon.call('POST', w(`/invoices/${inv.id}/payments`), {
          date: inv.payDay,
          accountId: acct.bank,
          amount: inv.amount,
          withheld: inv.withheld,
          reference: inv.withheld ? `Check ${rnd.int(500_100, 500_999)}, with Form 2307` : rnd.chance(0.5) ? `Bank transfer ${rnd.int(10_000, 99_999)}` : `Check ${rnd.int(200_100, 200_999)}`,
        })
      }
      for (const bill of billsToPay.splice(0)) {
        if (bill.payDay > day) {
          billsToPay.push(bill)
          continue
        }
        await ramon.call('POST', w(`/bills/${bill.id}/payments`), { date: bill.payDay, accountId: acct.bank, amount: bill.amount, reference: `Check ${rnd.int(100_200, 100_999)}` })
      }
    }

    /** Lots past their expiry, pulled off the shelves and written off to Spoilage (by the warehouse). */
    async function writeOffExpired(date: string) {
      for (const where of ['main', 'cold'] as const) {
        const lines = ITEMS.filter((it) => it.store === where).flatMap((it) => fefo(it.sku).filter((l) => l.expiry < date).map((l) => ({ sku: it.sku, lot: l })))
        if (!lines.length) continue
        await jomar.call('POST', w('/stock/adjustments'), {
          date,
          warehouseId: store[where],
          reason: 'expired',
          notes: 'Expired lots pulled from the shelves and disposed of',
          lines: lines.map(({ sku, lot }) => ({ itemId: item[sku], change: -lot.qty, lotNo: lot.lotNo })),
        })
        for (const { lot } of lines) lot.qty = 0
      }
    }

    /** Goods damaged in handling, from the lot being used. */
    async function damage(sku: string, qty: number, date: string, notes: string) {
      const lot = fefo(sku).find((l) => l.expiry >= date && l.qty >= qty)
      if (!lot) return
      await jomar.call('POST', w('/stock/adjustments'), { date, warehouseId: store[spec[sku]!.store], reason: 'damage', notes, lines: [{ itemId: item[sku], change: -qty, lotNo: lot.lotNo }] })
      lot.qty -= qty
    }

    /**
     * A work order in the premix room, run by Arnel: enough batches for two weeks (as many as the
     * materials allow), started and completed the same day. Now and then a bag splits at the seal
     * and is rejected in QC.
     */
    async function produce(sku: string, date: string, o: { force?: boolean; start?: boolean; complete?: boolean } = {}) {
      const it = spec[sku]!
      const m = it.made!
      let batches = Math.ceil((WEEKLY[sku]! * 2 - sellable(sku, date)) / m.batch)
      if (o.force) batches = Math.max(batches, 1)
      for (const [c, q] of m.lines) batches = Math.min(batches, Math.floor(sellable(c, date) / q))
      if (batches <= 0) return
      const quantity = batches * m.batch
      const wo = (await arnel.call('POST', w('/work-orders'), { itemId: item[sku], quantity, warehouseId: store.main, startDate: date, dueDate: addDays(date, 1) })).workOrder as WorkOrder
      await arnel.call('POST', w(`/work-orders/${wo.id}/release`))
      if (o.start === false) return
      await arnel.call('POST', w(`/work-orders/${wo.id}/start`), { date, materials: [] })
      for (const [c, q] of m.lines) take(c, q * batches, date)
      if (o.complete === false) return
      const rejected = rnd.chance(0.35) ? 1 : 0
      const lot = { lotNo: lotNo(sku, date), expiry: addDays(date, it.life), qty: quantity - rejected }
      await arnel.call('POST', w(`/work-orders/${wo.id}/complete`), {
        date,
        goodQty: lot.qty,
        rejectedQty: rejected,
        lotNo: lot.lotNo,
        expiryDate: lot.expiry,
        operations: wo.operations.map((op) => ({ operationId: op.id, minutes: Math.round(op.plannedMinutes * (0.9 + rnd.next() * 0.3)) })),
        qc: m.qc.map((_, i) => (rejected && i === 2 ? { passed: false, note: 'One bag split at the seal; swept up and discarded' } : { passed: true })),
      })
      stock[sku]!.push(lot)
    }

    /** Rent, electricity and trucking, billed monthly. */
    async function expense(sup: 'rent' | 'power' | 'trucking', date: string, description: string, amount: number, accountCode: string, ewt: string | null) {
      const bill = await ramon.call('POST', w('/bills'), {
        supplierId: supplier[sup],
        supplierInvoiceNo: `${sup === 'rent' ? 'SOA' : 'INV'}-${date.replace(/-/g, '').slice(2, 6)}${rnd.int(100, 999)}`,
        date,
        dueDate: addDays(date, sup === 'rent' ? 5 : 15),
        lines: [{ description, quantity: 1, unitPrice: peso(amount), vat: 'vatable', accountId: acct[accountCode], ewtCodeId: ewt ? tax[ewt] : null }],
      })
      const posted = (await ramon.call('POST', w(`/bills/${bill.bill.id}/post`))).bill as { amountDue: number }
      billsToPay.push({ id: bill.bill.id, amount: posted.amountDue, payDay: addDays(date, sup === 'rent' ? 4 : 12) })
    }
    const monthName = (date: string) => new Date(`${date}T00:00:00Z`).toLocaleString('en-PH', { month: 'long', year: 'numeric', timeZone: 'UTC' })

    /* ---------- day by day, from the first day to yesterday ---------- */

    const custOrder = ['bakery', 'hotel', 'ensaymada', 'resto', 'cafe', 'caterer']
    let turn = 0
    let mondays = 0
    for (const day of daysBetween(d(0), ago(1))) {
      const dow = weekday(day)
      const dom = Number(day.slice(8))
      if (dom === 1) await expense('rent', day, `Warehouse and office rent, ${monthName(day)}`, 75_000, '6100', 'WC100')
      if (dom === 10) await expense('power', day, `Electricity, cold room and warehouse, ${monthName(day)}`, 38_000 + rnd.int(0, 5_000), '6110', null)
      if (dom === 15) await expense('trucking', day, `Provincial pick-ups (Batangas, Bulacan), ${monthName(day)}`, 16_000 + rnd.int(0, 4_000), '6130', 'WC120')

      // Saturdays the buyer orders for the coming week; it arrives Monday. The last few days' orders are still on their way.
      if (dow === 6) {
        const receive = day < ago(1)
        const bill = day < ago(6)
        await restock('poultry', day, 1.5, { receive, bill })
        await restock('dairy', day, 3, { receive, bill })
        if (mondays++ % 2 === 0 || !receive) {
          await restock('flour', day, 4, { receive, bill })
          // the sugar mill's first bill charged ₱40 a sack over the order: purchase price variance
          await restock('sugar', day, 4, { receive, bill, billPrice: mondays === 1 ? { 'SUGAR-50': spec['SUGAR-50']!.cost + 40 } : undefined })
          await restock('oils', day, 4, { receive, bill })
          await restock('packaging', day, 4, { receive, bill })
        }
        await writeOffExpired(day)
      }
      if (dow === 0) continue // closed on Sundays
      // Tuesdays the premix room makes two weeks' worth of what's short
      if (dow === 2) for (const sku of MADE) await produce(sku, day)

      const late = day >= ago(5)
      const r = rnd.next()
      const orders = r < 0.25 ? 2 : r < 0.85 ? 1 : 0 // 1.1 a day on average: ORDERS_PER_DAY
      for (let i = 0; i < orders; i++) {
        const cust = custOrder[turn++ % custOrder.length]!
        // left unpaid: the restaurant's last three weeks, one hotel invoice, and everything recent
        const pay = late || (cust === 'resto' && day >= ago(21)) || (cust === 'hotel' && day >= ago(40) && day < ago(36)) ? 'no' : rnd.chance(0.15) ? 'late' : 'on-time'
        await sell({ cust, date: day, lines: basket(cust), fee: rnd.chance(0.35), pay })
      }
      if (rnd.chance(0.12)) await cashSale(day)
      // handling losses: cracked eggs most weeks, now and then freezer-burnt chicken or a mouldy cheese
      if (dow === 3 && rnd.chance(0.7)) await damage('EGGS-30', rnd.int(2, 6), day, 'Cracked trays found when loading the van')
      if (dom === 20) await damage('CHICKEN-KG', rnd.int(8, 15), day, 'Freezer burn after the cold room’s power interruption')
      if (dom === 12) await damage('CHEESE-2KG', rnd.int(1, 3), day, 'Packaging torn; mould on the loaves')
      if (dow === 5) await settle(day)
    }
    await settle(ago(1))

    // production for the visitor: chocolate premix started yesterday (to complete), pandesal premix released for today (to start)
    await produce('PREMIX-CHOCO', ago(1), { force: true, complete: false })
    await produce('PREMIX-PANDESAL', T, { force: true, start: false })

    // open orders for the visitor: half delivered, confirmed, and a draft
    await sell({ cust: 'hotel', date: ago(2), lines: [['CHICKEN-KG', 300], ['EGGS-30', 100], ['BUTTER-5KG', 12]], deliver: 'part', pay: 'no', po: `PO-${ago(2).replace(/-/g, '').slice(2)}-77` })
    await sell({ cust: 'bakery', date: ago(1), lines: [['FLOUR-AP25', 40], ['FLOUR-BR25', 20], ['YEAST-500', 30], ['SUGAR-50', 6]], fee: true, deliver: 'none' })
    await sell({ cust: 'caterer', date: ago(1), lines: [['CHICKEN-KG', 250], ['OIL-18L', 8], ['CREAM-12L', 6]], confirm: false })
    // yesterday's count in the cold room found trays that had been pushed behind a pallet, already expired:
    // the visitor writes them off ("Write off expired" on the Inventory page)
    await jomar.call('POST', w('/stock/adjustments'), {
      date: ago(1),
      warehouseId: store.cold,
      reason: 'count',
      notes: 'Weekly count: 6 trays found behind the pallets in bay 3, already past their date',
      lines: [{ itemId: item['EGGS-30'], change: 6, unitCost: peso(spec['EGGS-30']!.cost), lotNo: `EG-${ago(26).slice(5, 7)}${ago(26).slice(8, 10)}B`, expiryDate: ago(5) }],
    })

    // the yeast is under its reorder point, and more is on order
    await purchase('flour', ago(1), [['YEAST-500', roundUp(WEEKLY['YEAST-500']! * 2, 10)]], {})
    const yeast = sellable('YEAST-500', ago(1))
    const yeastLow = Math.floor(WEEKLY['YEAST-500']! * 0.6)
    if (yeast > yeastLow) await sell({ cust: 'bakery', date: ago(1), lines: [['YEAST-500', yeast - yeastLow]], pay: 'no' })

    /* ---------- the sales pipeline ---------- */

    async function lead(o: { title: string; company?: string; person: string; phone?: string; email?: string; source: string; value: number; close: string; customerId?: string; notes?: string; activities?: [string, string, string][] }) {
      const l = (
        await patricia.call<{ lead: LeadDetail }>('POST', w('/leads'), {
          title: o.title,
          companyName: o.company,
          personName: o.person,
          phone: o.phone,
          email: o.email,
          source: o.source,
          value: peso(o.value),
          expectedClose: o.close,
          customerId: o.customerId,
          notes: o.notes,
        })
      ).lead
      for (const [kind, body, date] of o.activities ?? []) await patricia.call('POST', w(`/leads/${l.id}/activities`), { kind, body, date })
      return l
    }

    await lead({
      title: 'Ingredients for 5 branches',
      company: 'Pan de Manila Bakery Corp.',
      person: 'Ernesto Villareal',
      phone: '0917 445 9902',
      source: 'referral',
      value: 1_200_000,
      close: addDays(T, 45),
      notes: 'Referred by Panaderia de Sta. Cruz. Buys centrally for five branches in Manila and Quezon City.',
      activities: [['call', 'Introduced ourselves; they want a price list for flour, sugar and butter.', ago(2)]],
    })
    await lead({ title: 'Catering ingredients for December events', company: 'Fiesta Events Catering', person: 'Joy Mercado', email: `joy.${tag}@${DEMO_EMAIL_DOMAIN}`, source: 'website', value: 180_000, close: addDays(T, 20) })

    const canteen = await lead({
      title: 'Frozen chicken for the school canteen',
      company: 'St. Joseph Academy Canteen',
      person: 'Sr. Teresita Ramos',
      phone: '0928 117 3054',
      source: 'cold_call',
      value: 240_000,
      close: addDays(T, 30),
      activities: [
        ['call', 'Feeds about 600 students a day. Wants weekly chicken deliveries starting January.', d(40)],
        ['meeting', 'Visited the canteen; they need delivery before 6 a.m. on Mondays.', d(47)],
      ],
    })
    await patricia.call('PATCH', w(`/leads/${canteen.id}/stage`), { stage: 'qualified' })

    // a café about to open: a customer now, with a quote out
    const brew = await lead({
      title: 'Dairy and baking supplies for a new café',
      company: 'Brew & Bean Coffee Co.',
      person: 'Marco Alvarez',
      phone: '0917 662 0841',
      source: 'social',
      value: 285_000,
      close: addDays(T, 10),
      activities: [['meeting', 'Tasting at their commissary. They liked the butter and the cream.', ago(9)]],
    })
    const brewCustomer = (await patricia.call<{ lead: LeadDetail }>('POST', w(`/leads/${brew.id}/convert`))).lead.customer!.id
    const brewQuote = (
      await patricia.call<{ quote: Quote }>('POST', w('/quotes'), {
        customerId: brewCustomer,
        leadId: brew.id,
        date: ago(8),
        validUntil: addDays(T, 14),
        notes: 'Prices good for 3 weeks. Free delivery on orders over ₱20,000.',
        lines: [
          { itemId: item['BUTTER-5KG'], quantity: 18, unitPrice: peso(2_380), vat: 'vatable' },
          { itemId: item['CREAM-12L'], quantity: 24, unitPrice: peso(1_930), vat: 'vatable' },
          { itemId: item['MILK-EVAP48'], quantity: 12, unitPrice: peso(2_160), vat: 'vatable' },
          { itemId: item['COCOA-1KG'], quantity: 30, unitPrice: peso(535), vat: 'vatable' },
        ],
      })
    ).quote
    await patricia.call('POST', w(`/quotes/${brewQuote.id}/send`))
    await patricia.call('PATCH', w(`/leads/${brew.id}/stage`), { stage: 'negotiation' })
    await patricia.call('POST', w(`/leads/${brew.id}/activities`), { kind: 'call', body: 'Asked for 30 days’ terms instead of 15. Checking with Carmela.', date: ago(3) })

    // the hotel's breakfast buffet: quoted, accepted, ordered (won)
    const buffet = await lead({ title: 'Breakfast buffet supply, Q4', person: 'Chef Andrei Navarro', customerId: customer.hotel, source: 'other', value: 450_000, close: ago(12) })
    const buffetQuote = (
      await patricia.call<{ quote: Quote }>('POST', w('/quotes'), {
        customerId: customer.hotel,
        leadId: buffet.id,
        date: ago(16),
        validUntil: addDays(ago(16), 30),
        lines: [
          { itemId: item['EGGS-30'], quantity: 120, unitPrice: peso(262), vat: 'vatable' },
          { itemId: item['BUTTER-5KG'], quantity: 18, unitPrice: peso(2_380), vat: 'vatable' },
          { itemId: item['CHEESE-2KG'], quantity: 24, unitPrice: peso(975), vat: 'vatable' },
        ],
      })
    ).quote
    await patricia.call('POST', w(`/quotes/${buffetQuote.id}/send`))
    await patricia.call('POST', w(`/quotes/${buffetQuote.id}/accept`))
    const buffetOrder = (await patricia.call<{ salesOrder: SalesOrder }>('POST', w(`/quotes/${buffetQuote.id}/order`))).salesOrder
    await patricia.call('POST', w(`/sales-orders/${buffetOrder.id}/confirm`))

    // one that got away
    const cakes = await lead({ title: 'Butter and cream for cakes', company: 'Cake Haven Bakeshop', person: 'Bea Robles', phone: '0919 220 7731', source: 'walk_in', value: 60_000, close: d(45), activities: [['note', 'Sent prices by Viber.', d(38)]] })
    await patricia.call('PATCH', w(`/leads/${cakes.id}/stage`), { stage: 'lost', lostReason: 'Chose a supplier in Cavite, closer to their kitchen.' })

    await patricia.call('POST', w(`/crm/customers/${customer.hotel}/activities`), { kind: 'meeting', body: 'Quarterly review with purchasing. They’ll add a second delivery day in December.', date: ago(10) })
    await patricia.call('POST', w(`/crm/customers/${customer.resto}/activities`), { kind: 'call', body: 'Reminded them of the overdue invoice (Ramon asked); they promised a check next week.', date: ago(2) })

    /* ---------- HR: employees, time, leave ---------- */

    const linked: Partial<Record<PersonSpec['key'], string>> = { owner: owner.id, ramon: ramon.id, liza: liza.id, jomar: jomar.id, patricia: patricia.id, arnel: arnel.id }
    const emp = {} as Record<PersonSpec['key'], Employee>
    for (const p of PEOPLE) {
      emp[p.key] = (
        await liza.call<{ employee: Employee }>('POST', w('/employees'), {
          firstName: p.firstName,
          lastName: p.lastName,
          position: p.position,
          department: p.department,
          hireDate: p.hireDate,
          payBasis: p.payBasis,
          rate: peso(p.rate),
          minimumWageEarner: p.minimumWageEarner ?? false,
          tracksAttendance: p.tracksAttendance,
          shiftStart: p.shiftStart ?? '08:00',
          restDays: p.restDays ?? [0],
          workDaysPerYear: p.workDaysPerYear ?? 261,
          workRegionCode: '130000000',
          userId: linked[p.key] ?? null,
          phone: `09${rnd.int(15, 49)} ${rnd.int(100, 999)} ${rnd.int(1000, 9999)}`,
          address: 'Quezon City, Metro Manila',
          ...p.ids,
        })
      ).employee
    }

    const leaveTypes = (await liza.call<{ leaveTypes: { id: string; code: string }[] }>('GET', w('/leave/types'))).leaveTypes
    const leaveType = (code: string) => leaveTypes.find((t) => t.code === code)!.id
    /** A workday on or after `date` (not Sunday). */
    const workday = (date: string) => (weekday(date) === 0 ? addDays(date, 1) : date)
    const onLeave = new Map<string, Set<string>>()
    async function leave(who: PersonSpec['key'], code: string, start: string, end: string, reason: string, decide: 'approve' | 'pending', by: Actor = liza) {
      const r = (await by.call('POST', w('/leave/requests'), { employeeId: emp[who].id, leaveTypeId: leaveType(code), startDate: start, endDate: end, reason })).request
      if (decide === 'approve') {
        await (who === 'liza' ? owner : liza).call('POST', w(`/leave/requests/${r.id}/approve`), { note: 'Okay, enjoy.' })
        const days = onLeave.get(emp[who].id) ?? new Set()
        for (const day of daysBetween(start, end)) days.add(day)
        onLeave.set(emp[who].id, days)
      }
    }
    const sl = workday(d(19))
    await leave('rowena', 'SL', sl, sl, 'Fever; medical certificate attached', 'approve')
    const vl = workday(d(36))
    await leave('efren', 'VL', vl, workday(addDays(vl, 1)), 'Sister’s wedding in Pampanga', 'approve')
    const pl = workday(d(50))
    await leave('patricia', 'VL', pl, pl, 'Renewing passport', 'approve')
    // waiting for the visitor (as owner) to decide, on the web or the phone
    await jomar.call('POST', w('/me/leave'), { leaveTypeId: leaveType('VL'), startDate: workday(addDays(T, 5)), endDate: workday(addDays(T, 6)), reason: 'Family reunion in Tarlac' })
    await leave('efren', 'SL', workday(addDays(T, 1)), workday(addDays(T, 1)), 'Dental surgery (filed by HR for him)', 'pending')

    // clock-ins from the phone, at the Quezon City warehouse, from the first day to yesterday
    const hols = new Map((await db.select().from(holidays).where(eq(holidays.workspaceId, ws))).map((h) => [h.date, h.kind]))
    const site = { lat: 14.6587, lng: 121.0306 }
    const rows: (typeof timeEntries.$inferInsert)[] = []
    for (const p of PEOPLE.filter((x) => x.tracksAttendance)) {
      const e = emp[p.key]
      const start = p.shiftStart ?? '08:00'
      const [sh, sm] = start.split(':').map(Number) as [number, number]
      for (const day of daysBetween(S, ago(1))) {
        const sunday = weekday(day) === 0
        const hol = hols.get(day)
        if (onLeave.get(e.id)?.has(day)) continue
        // Sundays off, but the drivers and the cold room cover a few; most take holidays off
        if (sunday && !(p.key === 'efren' || p.key === 'dennis') ) continue
        if (sunday && !rnd.chance(0.25)) continue
        if (hol && !(p.key === 'dennis' && rnd.chance(0.7))) continue
        if (!sunday && !hol && rnd.chance(0.03)) continue // an absence now and then
        const late = rnd.chance(0.12) ? rnd.int(5, 35) : 0
        const inMin = sh * 60 + sm - rnd.int(5, 15) + (late ? rnd.int(15, 20) + late : 0)
        const overtime = !sunday && rnd.chance(p.key === 'jomar' || p.key === 'efren' ? 0.18 : p.key === 'dennis' ? 0 : 0.06) ? rnd.int(1, 3) * 60 : 0
        const length = sunday ? 4 * 60 : 9 * 60
        const outMin = sh * 60 + sm + length + overtime + rnd.int(0, 12)
        // minutes from midnight, so a late shift can run past it
        const at = (min: number) => new Date(fromManila(`${day}T00:00`).getTime() + min * 60_000)
        const jitter = () => (rnd.next() - 0.5) * 0.0006
        rows.push({
          workspaceId: ws,
          employeeId: e.id,
          clockIn: at(inMin),
          clockOut: at(outMin),
          inLatitude: site.lat + jitter(),
          inLongitude: site.lng + jitter(),
          inAccuracy: rnd.int(5, 25),
          outLatitude: site.lat + jitter(),
          outLongitude: site.lng + jitter(),
          outAccuracy: rnd.int(5, 25),
          source: 'phone',
          createdBy: linked[p.key] ?? liza.id,
        })
      }
    }
    for (let i = 0; i < rows.length; i += 500) await db.insert(timeEntries).values(rows.slice(i, i + 500))

    /* ---------- projects: an expansion and a service ---------- */

    // the cold room is getting a second bay: an internal project, its costs going to Property and Equipment
    type Prj = { id: string; tasks: { id: string; name: string }[]; milestones: { id: string; name: string }[] }
    let expansion = (
      await owner.call<{ project: Prj }>('POST', w('/projects'), {
        name: 'Cold room expansion, Building B',
        status: 'active',
        startDate: d(20),
        endDate: addDays(T, 25),
        billing: 'none',
        costBudget: peso(850_000),
        siteAddress: 'Building B, 18 Mindanao Avenue, Quezon City',
        description: 'A second cold bay of 40 m² at 2–4 °C for eggs and dairy, with racking for 120 pallets. Needed before the December peak.',
      })
    ).project
    for (const [name, due] of [
      ['Permits approved', d(28)],
      ['Panels installed', ago(5)],
      ['Refrigeration running at 2–4 °C', addDays(T, 10)],
      ['Food-safety sign-off', addDays(T, 20)],
    ] as const) {
      expansion = (await owner.call<{ project: Prj }>('POST', w(`/projects/${expansion.id}/milestones`), { name, dueDate: due })).project
    }
    const ms = (name: string) => expansion.milestones.find((m) => m.name.startsWith(name))!.id
    const plan: { name: string; who?: string; from: string; to: string; hours: number; after?: string; field?: boolean; ms: string; status?: 'done' | 'in_progress'; progress?: number }[] = [
      { name: 'Design and city permits', who: owner.id, from: d(20), to: d(28), hours: 16, ms: 'Permits', status: 'done' },
      { name: 'Clear and prepare Bay B', who: jomar.id, from: d(29), to: d(33), hours: 40, after: 'Design and city permits', field: true, ms: 'Panels', status: 'done' },
      { name: 'Insulated panels and doors (contractor)', from: d(34), to: ago(6), hours: 0, after: 'Clear and prepare Bay B', field: true, ms: 'Panels', status: 'done' },
      { name: 'Electrical works and lighting (contractor)', from: ago(10), to: addDays(T, 3), hours: 0, after: 'Insulated panels and doors (contractor)', field: true, ms: 'Refrigeration', status: 'in_progress', progress: 60 },
      { name: 'Install racking and shelving', who: jomar.id, from: ago(2), to: addDays(T, 5), hours: 32, field: true, ms: 'Refrigeration', status: 'in_progress', progress: 30 },
      { name: 'Commission the refrigeration unit', who: owner.id, from: addDays(T, 6), to: addDays(T, 10), hours: 6, after: 'Electrical works and lighting (contractor)', field: true, ms: 'Refrigeration' },
      { name: 'Temperature mapping and food-safety inspection', who: owner.id, from: addDays(T, 14), to: addDays(T, 20), hours: 8, after: 'Commission the refrigeration unit', ms: 'Food-safety' },
    ]
    for (const t of plan) {
      expansion = (
        await owner.call<{ project: Prj }>('POST', w(`/projects/${expansion.id}/tasks`), {
          name: t.name,
          assigneeId: t.who,
          startDate: t.from,
          endDate: t.to,
          estimatedHours: t.hours,
          dependsOnId: t.after ? expansion.tasks.find((x) => x.name === t.after)!.id : null,
          milestoneId: ms(t.ms),
          fieldWork: !!t.field,
          location: t.field ? 'Building B, bay 2' : undefined,
        })
      ).project
    }
    const taskId = (name: string) => expansion.tasks.find((x) => x.name === name)!.id
    for (const [who, task, dates, hours, note] of [
      [owner, 'Design and city permits', [d(21), d(24), d(27)], 4, 'With the engineer at City Hall'],
      [jomar, 'Clear and prepare Bay B', [d(29), d(30), d(31), d(32), d(33)], 8, 'Moved dry stock to MAIN, cleaned and levelled the floor'],
      [jomar, 'Install racking and shelving', [ago(2), ago(1)], 6, 'Uprights for rows 1–3'],
    ] as const) {
      for (const date of dates) await who.call('POST', w('/timesheets'), { projectId: expansion.id, taskId: taskId(task), date, hours, note })
    }
    for (const t of plan.filter((x) => x.status)) {
      await owner.call('POST', w(`/projects/${expansion.id}/tasks/${taskId(t.name)}/progress`), { status: t.status, progress: t.progress })
    }
    await owner.call('POST', w(`/projects/${expansion.id}/milestones/${ms('Permits')}/done`), { done: true })
    await owner.call('POST', w(`/projects/${expansion.id}/milestones/${ms('Panels')}/done`), { done: true })
    // the contractors' bills, tagged to the project (an asset being built, so to Property and Equipment)
    const panelCo = (await ramon.call('POST', w('/contacts'), { name: 'Polar Panel Systems Inc.', tin: '213-559-402-00000', address: 'Carmona, Cavite', isSupplier: true, defaultEwtCodeId: tax.WC120 })).contact.id
    const sparky = (await ramon.call('POST', w('/contacts'), { name: 'Kislap Electrical Contractors', tin: '214-118-763-00000', address: 'Caloocan City', isSupplier: true, defaultEwtCodeId: tax.WC120 })).contact.id
    for (const [sup, date, description, amount, paid] of [
      [panelCo, ago(6), '100 mm PU insulated panels, 2 cold-room doors, installed (Bay B)', 380_000, true],
      [sparky, ago(3), 'Electrical works, 50% progress billing: wiring, lighting, panel board', 48_000, false],
    ] as const) {
      const b = (
        await ramon.call('POST', w('/bills'), {
          supplierId: sup,
          projectId: expansion.id,
          supplierInvoiceNo: `SI-${rnd.int(1000, 9999)}`,
          date,
          dueDate: addDays(date, 15),
          notes: description,
          lines: [{ description, quantity: 1, unitPrice: peso(amount), vat: 'vatable', accountId: acct['1500'], ewtCodeId: tax.WC120 }],
        })
      ).bill
      const posted = (await ramon.call('POST', w(`/bills/${b.id}/post`))).bill as { amountDue: number }
      if (paid) await ramon.call('POST', w(`/bills/${b.id}/payments`), { date: addDays(date, 3), accountId: acct.bank, amount: posted.amountDue, reference: `Check ${rnd.int(100_200, 100_999)}` })
    }

    // a service sold by the hour: costing the hotel kitchen's recipes and stores
    const costing = (
      await owner.call<{ project: Prj }>('POST', w('/projects'), {
        name: 'Hotel Marilag: kitchen costing and stores review',
        customerId: customer.hotel,
        managerId: patricia.id,
        status: 'active',
        startDate: ago(20),
        endDate: addDays(T, 10),
        billing: 'hourly',
        hourlyRate: peso(1_800),
        costBudget: peso(30_000),
        siteAddress: '1588 Roxas Boulevard, Malate, Manila (main kitchen)',
        description: 'Recipe costing for the breakfast buffet and banquet menus, and a review of the kitchen stores (par levels, rotation, spoilage).',
      })
    ).project
    let svc = costing
    for (const t of [
      { name: 'Stock-take of the kitchen stores', who: patricia.id, from: ago(20), to: ago(16), hours: 16, field: true },
      { name: 'Recipe costing: breakfast buffet', who: patricia.id, from: ago(15), to: ago(6), hours: 24 },
      { name: 'Par levels and ordering schedule', who: owner.id, from: ago(5), to: addDays(T, 4), hours: 12 },
      { name: 'Report and presentation to the F&B director', who: owner.id, from: addDays(T, 5), to: addDays(T, 10), hours: 6 },
    ]) {
      svc = (await owner.call<{ project: Prj }>('POST', w(`/projects/${costing.id}/tasks`), { name: t.name, assigneeId: t.who, startDate: t.from, endDate: t.to, estimatedHours: t.hours, fieldWork: !!t.field, location: t.field ? 'Main kitchen stores, basement' : undefined })).project
    }
    const svcTask = (name: string) => svc.tasks.find((x) => x.name.startsWith(name))!.id
    for (const [who, task, day, hours] of [
      [patricia, 'Stock-take', ago(20), 8],
      [patricia, 'Stock-take', ago(19), 7],
      [patricia, 'Recipe costing', ago(15), 6],
      [patricia, 'Recipe costing', ago(13), 7],
      [patricia, 'Recipe costing', ago(9), 5],
    ] as const) {
      await who.call('POST', w('/timesheets'), { projectId: costing.id, taskId: svcTask(task), date: day, hours })
    }
    await owner.call('POST', w(`/projects/${costing.id}/tasks/${svcTask('Stock-take')}/progress`), { status: 'done' })
    // the first two weeks are billed (posted, awaiting payment); what's logged since is for the visitor to bill
    const firstBill = (await ramon.call<{ invoiceId: string }>('POST', w(`/projects/${costing.id}/invoice-hours`), { upTo: ago(10) })).invoiceId
    await ramon.call('POST', w(`/invoices/${firstBill}/post`))
    for (const [who, task, day, hours] of [
      [patricia, 'Recipe costing', ago(7), 6],
      [owner, 'Par levels', ago(4), 3],
      [owner, 'Par levels', ago(2), 2.5],
    ] as const) {
      await who.call('POST', w('/timesheets'), { projectId: costing.id, taskId: svcTask(task), date: day, hours })
    }
    await owner.call('POST', w(`/projects/${costing.id}/tasks/${svcTask('Recipe costing')}/progress`), { status: 'in_progress', progress: 80 })

    /* ---------- payroll: semi-monthly, posted, paid, remitted ---------- */

    const periods: [string, string][] = []
    for (let start = S; ; ) {
      const end = start.slice(8) === '01' ? addDays(start, 14) : monthEnd(start)
      if (end >= T) break
      periods.push([start, end])
      start = addDays(end, 1)
    }
    for (const [i, [start, end]] of periods.entries()) {
      const run = (await liza.call<{ run: PayrollRun }>('POST', w('/payroll/runs'), { frequency: 'semi_monthly', periodStart: start, periodEnd: end, payDate: end })).run
      // month end: the rice allowance (de minimis) for the daily-paid; and Efren's cash advance comes off once
      for (const line of run.lines) {
        const adjustments: { label: string; amount: number; kind: string }[] = []
        if (run.takesContributions && line.payBasis === 'daily') adjustments.push({ label: 'Rice allowance', amount: peso(1_500), kind: 'nontaxable' })
        if (i === 1 && line.employee.id === emp.efren.id) adjustments.push({ label: 'Cash advance', amount: peso(2_000), kind: 'deduction' })
        if (adjustments.length) await liza.call('PUT', w(`/payroll/runs/${run.id}/lines/${line.id}`), { inputs: { ...line.inputs, adjustments } })
      }
      await liza.call('POST', w(`/payroll/runs/${run.id}/post`))
      // the latest is posted and waiting to be paid
      if (i < periods.length - 1) await ramon.call('POST', w(`/payroll/runs/${run.id}/pay`), { date: end, accountId: acct.bank })

      // the month's SSS, PhilHealth, Pag-IBIG and withholding tax go to the agencies by the 10th
      const due = addDays(end, 10)
      if (run.takesContributions && due < T) {
        const tb = (await ramon.call<{ report: TrialBalance }>('GET', w(`/reports/trial-balance?asOf=${end}`))).report
        const owed = (key: string) => -(tb.rows.find((r) => r.id === acct[key])?.balance ?? 0)
        const parts = [
          ['sss_payable', 'SSS contributions (R-3)'],
          ['philhealth_payable', 'PhilHealth premiums (RF-1)'],
          ['pagibig_payable', 'Pag-IBIG contributions'],
          ['wtax_comp_payable', 'Withholding tax on compensation (1601-C)'],
        ].filter(([key]) => owed(key!) > 0)
        const total = parts.reduce((s, [key]) => s + owed(key!), 0)
        const month = new Date(`${end}T00:00:00Z`).toLocaleString('en-PH', { month: 'long', year: 'numeric', timeZone: 'UTC' })
        const je = await ramon.call('POST', w('/journal'), {
          date: due,
          memo: `Government remittances for ${month}`,
          lines: [...parts.map(([key, label]) => ({ accountId: acct[key!], debit: owed(key!), description: label })), { accountId: acct.bank, credit: total, description: 'Online payments' }],
        })
        await ramon.call('POST', w(`/journal/${je.entry.id}/post`))
      }
    }

    await db.update(demoAccounts).set({ ready: true }).where(eq(demoAccounts.userId, owner.id))
    return { userId: owner.id, workspaceId: ws }
  } catch (e) {
    await purgeDemos([owner.id]).catch(() => undefined)
    throw e
  } finally {
    if (sessionIds.length) await db.delete(sessions).where(inArray(sessions.id, sessionIds))
  }
}

/**
 * Deletes demos: their workspaces (with everything in them, which the purge setting lets past the
 * "posted records are final" triggers), anything else their owners made while trying things out,
 * and every account made for them.
 */
export async function purgeDemos(ownerIds: string[]) {
  if (!ownerIds.length) return 0
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL erp.purge = 'on'`)
    const rows = await tx.select({ workspaceId: demoAccounts.workspaceId }).from(demoAccounts).where(inArray(demoAccounts.userId, ownerIds))
    const workspaceIds = rows.map((r) => r.workspaceId)
    const staff = workspaceIds.length
      ? await tx
          .select({ id: users.id })
          .from(memberships)
          .innerJoin(users, eq(users.id, memberships.userId))
          .where(and(inArray(memberships.workspaceId, workspaceIds), like(users.email, `%@${DEMO_EMAIL_DOMAIN}`)))
      : []
    await tx.delete(workspaces).where(or(workspaceIds.length ? inArray(workspaces.id, workspaceIds) : undefined, inArray(workspaces.createdBy, ownerIds)))
    await tx.delete(users).where(inArray(users.id, [...ownerIds, ...staff.map((u) => u.id)]))
    // the demos' staff accounts, now in no workspace (only older than an hour: one being built may not have joined yet)
    await tx.delete(users).where(
      and(
        like(users.email, `%@${DEMO_EMAIL_DOMAIN}`),
        lt(users.createdAt, new Date(Date.now() - 3_600_000)),
        sql`NOT EXISTS (SELECT 1 FROM ${memberships} WHERE ${memberships.userId} = ${users.id})`,
        sql`NOT EXISTS (SELECT 1 FROM ${demoAccounts} WHERE ${demoAccounts.userId} = ${users.id})`,
      ),
    )
  })
  return ownerIds.length
}
