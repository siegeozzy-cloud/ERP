import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import type { Account, Bom, MrpPlan, Role, Unit, Warehouse, WorkOrder } from '@erp/shared'
import { sql } from 'drizzle-orm'
import { buildApp } from '../src/app.ts'
import { db, pool, runMigrations } from '../src/db/client.ts'
import { sessions, users } from '../src/db/schema.ts'
import { hashToken, newToken } from '../src/lib/crypto.ts'

// Phase 6: a bakery supplier blends bread premix (flour, sugar, yeast, a printed bag) and makes
// frozen dough from the premix: two levels of bills of materials. Work orders take materials out
// of stock into Work in Process, apply labour and overhead, and put the good bags into stock; the
// rejects go to Spoilage. MRP turns a big order for dough into premix to make and flour to buy.

const app = await buildApp()
const run = Date.now()

async function makeUser(name: string) {
  const [user] = await db
    .insert(users)
    .values({ email: `mfg+${name.toLowerCase()}+${run}@example.com`, name, passwordHash: 'x', emailVerifiedAt: new Date(), termsAcceptedAt: new Date() })
    .returning()
  const token = newToken()
  await db.insert(sessions).values({ id: hashToken(token), userId: user!.id, remember: false, expiresAt: new Date(Date.now() + 3_600_000) })
  return {
    id: user!.id,
    call: async (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: object) => {
      const r = await app.inject({ method, url, payload, headers: { authorization: `Bearer ${token}` } })
      return { status: r.statusCode, body: r.body ? r.json() : undefined }
    },
  }
}

let owner: Awaited<ReturnType<typeof makeUser>>
let ws = ''
const w = (p: string) => `/api/w/${ws}${p}`
const call = (...a: Parameters<typeof owner.call>) => owner.call(...a)
const acct: Record<string, string> = {}
const item: Record<string, string> = {}
const wc: Record<string, string> = {}
let main = ''
let supplier = ''

const asOf = '2030-12-31'
const balanceOf = async (key: string) => {
  const tb = (await call('GET', w(`/reports/trial-balance?asOf=${asOf}`))).body.report
  return tb.rows.find((r: { id: string }) => r.id === acct[key])?.balance ?? 0
}
const valuation = async () => (await call('GET', w(`/inventory/valuation?asOf=${asOf}`))).body.total as number
const onHand = async (sku: string) => (await call('GET', w(`/items/${item[sku]}`))).body.item.onHand as number

before(async () => {
  await runMigrations()
  owner = await makeUser('Nena')
  const r = await call('POST', '/api/workspaces', { template: 'food', name: 'Masa Premix Corp.', tin: '321-654-987-00000', vatStatus: 'vat', street: 'Malabon' })
  ws = r.body.workspace.id
  for (const a of (await call('GET', w('/accounts'))).body.accounts as Account[]) if (a.systemKey) acct[a.systemKey] = a.id
  const units = (await call('GET', w('/units'))).body.units as Unit[]
  const unit = (code: string) => units.find((u) => u.code === code)!.id
  main = ((await call('GET', w('/warehouses'))).body.warehouses as Warehouse[])[0]!.id
  supplier = (await call('POST', w('/contacts'), { name: 'Harina Mills', isSupplier: true })).body.contact.id
  const add = async (sku: string, name: string, u: string, lots: boolean, extra = {}) => {
    const res = await call('POST', w('/items'), { sku, name, unitId: unit(u), trackLots: lots, trackExpiry: lots, ...extra })
    assert.equal(res.status, 201, JSON.stringify(res.body))
    item[sku] = res.body.item.id
  }
  await add('FLOUR', 'Bread flour, 25 kg', 'sack', true, { reorderPoint: 10, reorderQty: 50, purchaseCost: 1_000_00 })
  await add('SUGAR', 'Sugar, 50 kg', 'sack', true)
  await add('YEAST', 'Yeast, 500 g', 'pack', true)
  await add('BAG', 'Printed premix bag', 'pc', false)
  await add('PREMIX', 'Pandesal premix, 25 kg', 'sack', true, { salesPrice: 1_800_00 })
  await add('DOUGH', 'Frozen pandesal dough, tray', 'tray', true, { salesPrice: 300_00 })
  const opening = await call('POST', w('/stock/adjustments'), {
    date: '2026-10-01',
    warehouseId: main,
    reason: 'opening',
    lines: [
      { itemId: item.FLOUR, change: 5, unitCost: 1_000_00, lotNo: 'F-OLD', expiryDate: '2026-10-15' },
      { itemId: item.FLOUR, change: 30, unitCost: 1_000_00, lotNo: 'F-NEW', expiryDate: '2027-06-30' },
      { itemId: item.SUGAR, change: 10, unitCost: 3_000_00, lotNo: 'S1', expiryDate: '2027-12-31' },
      { itemId: item.YEAST, change: 100, unitCost: 150_00, lotNo: 'Y1', expiryDate: '2027-09-30' },
      { itemId: item.BAG, change: 100, unitCost: 20_00 },
    ],
  })
  assert.equal(opening.status, 201, JSON.stringify(opening.body))
})
after(async () => {
  await app.close()
  await pool.end()
})

let premixBom: Bom

test('work centres and a two-level bill of materials, costed and kept free of loops', async () => {
  for (const [code, name, rate] of [['MIX', 'Mixing room', 600_00], ['PACK', 'Packing line', 300_00]] as const) {
    const r = await call('POST', w('/work-centers'), { code, name, costPerHour: rate })
    assert.equal(r.status, 201, JSON.stringify(r.body))
    wc[code] = r.body.workCenter.id
  }
  assert.equal((await call('POST', w('/work-centers'), { code: 'mix', name: 'Again', costPerHour: 1 })).body.error.field, 'code')

  const r = await call('POST', w('/boms'), {
    itemId: item.PREMIX,
    outputQty: 10,
    lines: [
      { itemId: item.FLOUR, quantity: 9 },
      { itemId: item.SUGAR, quantity: 1 },
      { itemId: item.YEAST, quantity: 10 },
      { itemId: item.BAG, quantity: 10 },
    ],
    operations: [
      { workCenterId: wc.MIX, description: 'Blend 15 minutes', minutes: 60 },
      { workCenterId: wc.PACK, description: 'Weigh, fill and seal', minutes: 30 },
    ],
    qcChecks: ['Each bag 25 kg ± 100 g', 'Moisture under 14%'],
  })
  assert.equal(r.status, 201, JSON.stringify(r.body))
  premixBom = r.body.bom
  assert.equal(premixBom.code, 'BOM-PREMIX-1')
  // per batch of 10: materials 9,000 + 3,000 + 1,500 + 200 = ₱13,700; mixing ₱600 + packing ₱150
  assert.equal(premixBom.materialCost, 13_700_00)
  assert.equal(premixBom.conversionCost, 750_00)
  assert.equal(premixBom.unitCost, 1_445_00)

  const dough = await call('POST', w('/boms'), {
    itemId: item.DOUGH,
    outputQty: 20,
    lines: [
      { itemId: item.PREMIX, quantity: 1 },
      { itemId: item.YEAST, quantity: 2 },
    ],
    operations: [{ workCenterId: wc.MIX, description: 'Knead, portion and freeze', minutes: 20 }],
  })
  assert.equal(dough.status, 201, JSON.stringify(dough.body))
  // the premix isn't in stock yet, so its cost is rolled up from its own BOM
  assert.equal((dough.body.bom as Bom).lines[0]!.item.made, true)
  assert.equal((dough.body.bom as Bom).lines[0]!.averageCost, 1_445_00)
  assert.equal((await call('GET', w(`/boms/${premixBom.id}`))).body.bom.usedIn[0].item.name, 'Frozen pandesal dough, tray')

  // premix made of dough (made of premix) would never end
  const loop = await call('POST', w('/boms'), { itemId: item.PREMIX, outputQty: 1, lines: [{ itemId: item.DOUGH, quantity: 1 }] })
  assert.equal(loop.body.error.code, 'bom-loop')
  assert.match(loop.body.error.message, /out of itself/)
})

let wo: WorkOrder

test('a work order: planned from the BOM, started (materials into WIP, never an expired lot), and completed with QC', async () => {
  const r = await call('POST', w('/work-orders'), { itemId: item.PREMIX, quantity: 20, warehouseId: main, startDate: '2026-11-02', dueDate: '2026-11-03' })
  assert.equal(r.status, 201, JSON.stringify(r.body))
  wo = r.body.workOrder
  assert.equal(wo.status, 'draft')
  assert.deepEqual(wo.materials.map((m) => m.plannedQty), [18, 2, 20, 20])
  assert.deepEqual(wo.operations.map((o) => o.plannedMinutes), [120, 60])
  assert.equal((await call('POST', w(`/work-orders/${wo.id}/complete`), { date: '2026-11-02', goodQty: 1 })).status, 409)

  wo = (await call('POST', w(`/work-orders/${wo.id}/release`))).body.workOrder
  assert.equal(wo.number, 'WO-000001')
  const started = await call('POST', w(`/work-orders/${wo.id}/start`), { date: '2026-11-02', materials: [] })
  assert.equal(started.status, 200, JSON.stringify(started.body))
  wo = started.body.workOrder
  assert.equal(wo.status, 'in_progress')
  // 18 × 1,000 + 2 × 3,000 + 20 × 150 + 20 × 20
  assert.equal(wo.materialCost, 27_400_00)
  assert.equal(await balanceOf('wip'), 27_400_00)
  // the 5 expired sacks stayed: 12 good ones left
  const flour = (await call('GET', w(`/items/${item.FLOUR}`))).body.item
  assert.deepEqual(flour.levels.map((l: { lot: { lotNo: string }; quantity: number }) => `${l.lot.lotNo}:${l.quantity}`).sort(), ['F-NEW:12', 'F-OLD:5'])

  // quality control: every check answered; a failure needs a reason and rejected units
  const base = { date: '2026-11-03', goodQty: 19, lotNo: 'PX-1103', expiryDate: '2027-03-03' }
  assert.equal((await call('POST', w(`/work-orders/${wo.id}/complete`), { ...base, qc: [{ passed: true }] })).body.error.field, 'qc')
  assert.equal((await call('POST', w(`/work-orders/${wo.id}/complete`), { ...base, qc: [{ passed: true }, { passed: false }] })).body.error.field, 'qc')
  assert.equal((await call('POST', w(`/work-orders/${wo.id}/complete`), { ...base, qc: [{ passed: true }, { passed: false, note: 'One bag at 15%' }] })).body.error.field, 'rejectedQty')

  const done = await call('POST', w(`/work-orders/${wo.id}/complete`), {
    ...base,
    rejectedQty: 1,
    qc: [{ passed: true }, { passed: false, note: 'One bag at 15% moisture' }],
    operations: [{ operationId: wo.operations[0]!.id, minutes: 130 }],
  })
  assert.equal(done.status, 200, JSON.stringify(done.body))
  wo = done.body.workOrder
  assert.equal(wo.status, 'completed')
  assert.equal(wo.lot?.lotNo, 'PX-1103')
  // labour and overhead: mixing 130 min at ₱600 an hour, packing 60 min at ₱300
  assert.equal(wo.conversionCost, 1_300_00 + 300_00)
  const total = 27_400_00 + 1_600_00
  assert.equal(wo.unitCost, total / 20)
  assert.equal(await balanceOf('wip'), 0)
  assert.equal(await balanceOf('applied_overhead'), -1_600_00)
  assert.equal(await balanceOf('spoilage'), total / 20)
  assert.equal(await onHand('PREMIX'), 19)
  assert.equal(await valuation(), await balanceOf('inventory'))
  assert.equal(wo.entries.length, 2)
  assert.deepEqual(wo.qc.map((c) => c.passed), [true, false])

  const refused = (e: unknown) => /completed work order can.t be changed/.test(String((e as { cause?: Error }).cause?.message))
  await assert.rejects(db.execute(sql`update work_orders set good_qty = 100 where id = ${wo.id}`), refused)
  assert.equal((await call('POST', w(`/work-orders/${wo.id}/cancel`))).status, 409)
})

test('cancelling a started work order puts its materials back', async () => {
  const before = { flour: await onHand('FLOUR'), value: await valuation() }
  const r = (await call('POST', w('/work-orders'), { itemId: item.PREMIX, quantity: 10, warehouseId: main, startDate: '2026-11-04', dueDate: '2026-11-04' })).body.workOrder as WorkOrder
  const started = await call('POST', w(`/work-orders/${r.id}/start`), { date: '2026-11-04', materials: [{ materialId: r.materials[0]!.id, quantity: 8 }] })
  assert.equal(started.status, 200, JSON.stringify(started.body))
  assert.equal(started.body.workOrder.number, 'WO-000002') // released on the way
  assert.equal(started.body.workOrder.materials[0].issuedQty, 8)
  assert.equal(await onHand('FLOUR'), before.flour - 8)
  const cancelled = await call('POST', w(`/work-orders/${r.id}/cancel`))
  assert.equal(cancelled.body.workOrder.status, 'cancelled')
  assert.equal(await onHand('FLOUR'), before.flour)
  assert.equal(await valuation(), before.value)
  assert.equal(await balanceOf('wip'), 0)
})

test('MRP: a big order for dough means premix to make and flour to buy, then a draft purchase order', async () => {
  const customer = (await call('POST', w('/contacts'), { name: 'Bakers Guild', isCustomer: true })).body.contact.id
  const so = (await call('POST', w('/sales-orders'), { customerId: customer, date: '2026-11-05', warehouseId: main, lines: [{ itemId: item.DOUGH, quantity: 500, unitPrice: 300_00, vat: 'vatable' }] })).body.salesOrder
  assert.equal((await call('POST', w(`/sales-orders/${so.id}/confirm`))).status, 200)

  const plan = (await call('GET', w('/mrp'))).body.plan as MrpPlan
  const row = (sku: string) => plan.rows.find((r) => r.item.sku === sku)!
  // dough: 500 on order, none on hand → make 500 (level 0)
  assert.deepEqual([row('DOUGH').action, row('DOUGH').level, row('DOUGH').suggested], ['make', 0, 500])
  // premix: 500 trays ÷ 20 × 1 = 25 needed, 19 on hand → make 6 (level 1)
  assert.deepEqual([row('PREMIX').action, row('PREMIX').level, row('PREMIX').demand.planned, row('PREMIX').suggested], ['make', 1, 25, 6])
  // flour: 6 bags of premix need 5.4 sacks; 12 good ones (the expired 5 don't count) leaves 6.6, under the reorder point of 10 → buy the reorder quantity
  assert.equal(row('FLOUR').onHand, 12)
  assert.equal(row('FLOUR').demand.planned, 5.4)
  assert.deepEqual([row('FLOUR').action, row('FLOUR').suggested], ['buy', 50])

  const bought = await call('POST', w('/mrp/purchase-orders'), { warehouseId: main, lines: [{ itemId: item.FLOUR, supplierId: supplier, quantity: 50, unitCost: 1_000_00 }] })
  assert.equal(bought.status, 201, JSON.stringify(bought.body))
  const po = (await call('GET', w(`/purchase-orders/${bought.body.purchaseOrders[0].id}`))).body.purchaseOrder
  assert.equal(po.status, 'draft')
  assert.equal(po.lines[0].quantity, 50)

  const overview = (await call('GET', w('/manufacturing/overview'))).body.overview
  assert.equal(overview.madeThisMonth >= 0, true)
  assert.equal(overview.toMake, 2)
  assert.deepEqual(overview.load.map((l: { workCenter: { code: string } }) => l.workCenter.code), ['MIX', 'PACK'])
})

test('production staff run work orders but not the books; and the module can be turned off', async () => {
  const roles = (await call('GET', w('/roles'))).body.roles as Role[]
  const code = (await call('POST', w('/join-codes'), { roleId: roles.find((r) => r.name === 'Production staff')!.id })).body.code.code
  const staff = await makeUser('Dodong')
  assert.equal((await staff.call('POST', '/api/workspaces/join', { code })).status, 200)
  const r = await staff.call('POST', w('/work-orders'), { itemId: item.PREMIX, quantity: 10, warehouseId: main, startDate: '2026-11-06', dueDate: '2026-11-06' })
  assert.equal(r.status, 201, JSON.stringify(r.body))
  assert.equal((await staff.call('GET', w('/invoices'))).status, 403)
  assert.equal((await staff.call('POST', w('/mrp/purchase-orders'), { warehouseId: main, lines: [{ itemId: item.FLOUR, supplierId: supplier, quantity: 1, unitCost: 1 }] })).status, 403)

  const current = (await call('GET', w(''))).body.workspace
  await call('PATCH', w(''), { ...current, modules: ['finance', 'inventory'] })
  assert.equal((await call('GET', w('/boms'))).body.error.code, 'module-off')
  await call('PATCH', w(''), { ...current, modules: current.modules })
  const tb = (await call('GET', w(`/reports/trial-balance?asOf=${asOf}`))).body.report
  assert.equal(tb.totalDebit, tb.totalCredit)
})
