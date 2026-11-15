import type { PsgcAddress, PsgcPlace } from '@erp/shared'
import { asc, eq, isNull, and, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { db } from '../../db/client.ts'
import { psgcBarangays, psgcCities, psgcProvinces, psgcRegions } from '../../db/schema.ts'
import type { Executor, Tx } from '../../db/types.ts'
import { HttpError, parse } from '../../lib/errors.ts'
import { requireAuth } from '../../lib/session.ts'

/**
 * The Philippine Standard Geographic Code: region → province → city/municipality → barangay.
 *
 * It's loaded into our own tables once (`npm run psgc:load -w @erp/api`), so the address picker
 * never depends on an outside service being up during a demo. When it hasn't been loaded, the
 * picker answers with empty lists and the apps fall back to a plain address box.
 */

const code = z.string().regex(/^\d{9}$/)

/** Metro Manila's cities, Isabela City and Cotabato City belong to no province: "none" picks those. */
export const NO_PROVINCE = 'none'

export default async function psgcRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth)
  // the lists never change between loads, so browsers may keep them for a day
  app.addHook('onSend', async (_req, reply) => void reply.header('Cache-Control', 'private, max-age=86400'))

  app.get('/regions', async () => ({ places: await db.select({ code: psgcRegions.code, name: psgcRegions.name }).from(psgcRegions).orderBy(asc(psgcRegions.code)) }))

  /** A region's provinces, plus whether it also has cities that belong to no province. */
  app.get('/provinces', async (req) => {
    const { region } = parse(z.object({ region: code }), req.query)
    const places = await db.select({ code: psgcProvinces.code, name: psgcProvinces.name }).from(psgcProvinces).where(eq(psgcProvinces.regionCode, region)).orderBy(asc(psgcProvinces.name))
    const [independent] = await db.select({ n: sql<number>`count(*)::int` }).from(psgcCities).where(and(eq(psgcCities.regionCode, region), isNull(psgcCities.provinceCode)))
    return { places, independentCities: (independent?.n ?? 0) > 0 }
  })

  app.get('/cities', async (req) => {
    const q = parse(z.object({ region: code, province: z.union([code, z.literal(NO_PROVINCE)]) }), req.query)
    const where = q.province === NO_PROVINCE ? and(eq(psgcCities.regionCode, q.region), isNull(psgcCities.provinceCode)) : eq(psgcCities.provinceCode, q.province)
    return { places: await db.select({ code: psgcCities.code, name: psgcCities.name }).from(psgcCities).where(where).orderBy(asc(psgcCities.name)) }
  })

  app.get('/barangays', async (req) => {
    const { city } = parse(z.object({ city: code }), req.query)
    return { places: await db.select({ code: psgcBarangays.code, name: psgcBarangays.name }).from(psgcBarangays).where(eq(psgcBarangays.cityCode, city)).orderBy(asc(psgcBarangays.name)) }
  })

  /** A barangay with everything above it, for showing a saved address back in the picker. */
  app.get('/address/:code', async (req) => {
    const { code: c } = parse(z.object({ code }), req.params)
    const address = await addressOf(db, c)
    if (!address) throw new HttpError(404, 'not-found', 'That barangay isn’t in the list.')
    return { address }
  })
}

export async function addressOf(db: Executor, barangayCode: string): Promise<PsgcAddress | null> {
  const [row] = await db
    .select({
      barangay: { code: psgcBarangays.code, name: psgcBarangays.name },
      city: { code: psgcCities.code, name: psgcCities.name },
      province: { code: psgcProvinces.code, name: psgcProvinces.name },
      region: { code: psgcRegions.code, name: psgcRegions.name, shortName: psgcRegions.shortName },
    })
    .from(psgcBarangays)
    .innerJoin(psgcCities, eq(psgcCities.code, psgcBarangays.cityCode))
    .leftJoin(psgcProvinces, eq(psgcProvinces.code, psgcCities.provinceCode))
    .innerJoin(psgcRegions, eq(psgcRegions.code, psgcCities.regionCode))
    .where(eq(psgcBarangays.code, barangayCode))
  if (!row) return null
  return { barangay: row.barangay, city: row.city, province: row.province?.code ? (row.province as PsgcPlace) : null, region: { code: row.region.code, name: row.region.name } }
}

/**
 * The address as it prints: "88 Mabini St., Ermita, City of Manila, NCR". With a barangay code it's
 * written out from the official names; without one, `street` already is the whole address.
 */
export async function composeAddress(db: Executor, street: string, barangayCode: string | null) {
  if (!barangayCode) return { registeredAddress: street, regionCode: null, provinceCode: null, cityCode: null, barangayCode: null }
  const [row] = await db
    .select({ barangay: psgcBarangays.name, city: psgcCities.name, cityCode: psgcCities.code, province: psgcProvinces.name, provinceCode: psgcProvinces.code, region: psgcRegions.shortName, regionCode: psgcRegions.code })
    .from(psgcBarangays)
    .innerJoin(psgcCities, eq(psgcCities.code, psgcBarangays.cityCode))
    .leftJoin(psgcProvinces, eq(psgcProvinces.code, psgcCities.provinceCode))
    .innerJoin(psgcRegions, eq(psgcRegions.code, psgcCities.regionCode))
    .where(eq(psgcBarangays.code, barangayCode))
  if (!row) throw new HttpError(400, 'invalid', 'Choose a barangay from the list.', 'barangayCode')
  const parts = [street, row.barangay.startsWith('Barangay') ? row.barangay : `Brgy. ${row.barangay}`, row.city, row.province ?? row.region]
  return { registeredAddress: parts.join(', '), regionCode: row.regionCode, provinceCode: row.provinceCode, cityCode: row.cityCode, barangayCode }
}

/* ---------------------------------------------------------------------------------------------
 * Loading
 * ------------------------------------------------------------------------------------------- */

type Raw = {
  regions: { code: string; name: string; regionName: string }[]
  provinces: { code: string; name: string; regionCode: string }[]
  cities: { code: string; name: string; regionCode: string; provinceCode: string | false; isCity: boolean }[]
  barangays: { code: string; name: string; cityCode: string | false; municipalityCode: string | false }[]
}

/**
 * The PSGC gives each region two names, but not consistently: "Ilocos Region" / "Region I", yet
 * "NCR" / "National Capital Region". The longer one is the full name. The picker shows both;
 * addresses use the short one, except Metro Manila, which is what people write.
 */
export function regionNames(r: { code: string; name: string; regionName: string }) {
  const [long, short] = r.name.length >= r.regionName.length ? [r.name, r.regionName] : [r.regionName, r.name]
  return { code: r.code, name: long === short ? long : `${long} (${short})`, shortName: r.code === '130000000' ? 'Metro Manila' : short }
}

/** Replaces the tables' contents with `data`, in one transaction (the picker never sees half a list). */
export async function loadPsgc(tx: Tx, data: Raw) {
  await tx.delete(psgcBarangays)
  await tx.delete(psgcCities)
  await tx.delete(psgcProvinces)
  await tx.delete(psgcRegions)
  await tx.insert(psgcRegions).values(data.regions.map(regionNames))
  await tx.insert(psgcProvinces).values(data.provinces.map((p) => ({ code: p.code, name: p.name, regionCode: p.regionCode })))
  await tx.insert(psgcCities).values(data.cities.map((c) => ({ code: c.code, name: c.name, regionCode: c.regionCode, provinceCode: c.provinceCode || null, isCity: c.isCity })))
  const rows = data.barangays.map((b) => ({ code: b.code, name: b.name, cityCode: (b.cityCode || b.municipalityCode) as string })).filter((b) => b.cityCode)
  // Postgres takes at most 65,535 parameters per statement: 3 per row, so batches of 5,000
  for (let i = 0; i < rows.length; i += 5000) await tx.insert(psgcBarangays).values(rows.slice(i, i + 5000))
  return { regions: data.regions.length, provinces: data.provinces.length, cities: data.cities.length, barangays: rows.length }
}
