import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { db, pool, runMigrations } from '../db/client.ts'
import { loadPsgc } from '../features/psgc/psgc.ts'

// `npm run psgc:load -w @erp/api` — fills the address picker's lists from the PSGC.
//
// By default it downloads the current lists from psgc.gitlab.io (about 11 MB). Pass a folder with
// regions.json, provinces.json, cities-municipalities.json and barangays.json to load those instead.
// Safe to run again: it replaces what's there.

const SOURCE = 'https://psgc.gitlab.io/api'
const FILES = { regions: 'regions', provinces: 'provinces', cities: 'cities-municipalities', barangays: 'barangays' } as const

const folder = process.argv[2]

async function read(name: string) {
  if (folder) return JSON.parse(await readFile(path.join(folder, `${name}.json`), 'utf8'))
  const res = await fetch(`${SOURCE}/${name}.json`, { signal: AbortSignal.timeout(120_000) })
  if (!res.ok) throw new Error(`${SOURCE}/${name}.json answered ${res.status}`)
  return res.json()
}

await runMigrations()
console.log(folder ? `Reading the PSGC from ${folder}…` : `Downloading the PSGC from ${SOURCE}…`)
const data = {
  regions: await read(FILES.regions),
  provinces: await read(FILES.provinces),
  cities: await read(FILES.cities),
  barangays: await read(FILES.barangays),
}
const counts = await db.transaction((tx) => loadPsgc(tx, data))
console.log(`Loaded ${counts.regions} regions, ${counts.provinces} provinces, ${counts.cities} cities and municipalities, ${counts.barangays} barangays.`)
await pool.end()
