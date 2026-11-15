import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { NativeSelect } from '@/components/ui/native-select'
import { psgcQueries } from './queries'

const NO_PROVINCE = 'none'

/**
 * Region → province → city/municipality → barangay, from the official PSGC list, then the house
 * and street. Regions without provinces (Metro Manila) skip that step.
 *
 * When the list hasn't been loaded on the server, it's just one box for the whole address.
 */
export function AddressPicker({
  street,
  barangayCode,
  onChange,
  error,
}: {
  street: string
  barangayCode: string | null
  onChange: (value: { street: string; barangayCode: string | null }) => void
  error?: string
}) {
  const regions = useQuery(psgcQueries.regions())
  const saved = useQuery(psgcQueries.address(barangayCode))
  const [region, setRegion] = useState('')
  const [province, setProvince] = useState('')
  const [city, setCity] = useState('')

  // an address saved earlier: show the choices that lead to it
  useEffect(() => {
    if (!saved.data) return
    setRegion(saved.data.region.code)
    setProvince(saved.data.province?.code ?? NO_PROVINCE)
    setCity(saved.data.city.code)
  }, [saved.data])

  const provinces = useQuery(psgcQueries.provinces(region))
  const hasProvinces = (provinces.data?.places.length ?? 0) > 0
  // no provinces at all (Metro Manila): straight to the cities
  const provinceKey = hasProvinces ? province : region && provinces.data ? NO_PROVINCE : ''
  const cities = useQuery(psgcQueries.cities(region, provinceKey))
  const barangays = useQuery(psgcQueries.barangays(city))

  const listed = (regions.data?.length ?? 0) > 0
  if (regions.isPending) return <p className="text-muted-foreground text-sm">Loading the list of places…</p>

  if (!listed) {
    return (
      <div className="grid gap-2">
        <Label htmlFor="street">Registered address</Label>
        <Input id="street" value={street} aria-invalid={!!error} onChange={(e) => onChange({ street: e.target.value, barangayCode: null })} />
        {error && <p className="text-destructive text-sm">{error}</p>}
      </div>
    )
  }

  const pick = (setter: (v: string) => void, clear: (() => void)[]) => (v: string) => {
    setter(v)
    clear.forEach((c) => c())
    onChange({ street, barangayCode: null })
  }

  return (
    <fieldset className="grid gap-3">
      <legend className="mb-1 text-sm font-medium">Registered address</legend>
      <div className="grid gap-3 sm:grid-cols-2">
        <Place id="region" label="Region" value={region} onChange={pick(setRegion, [() => setProvince(''), () => setCity('')])} places={regions.data ?? []} />
        {hasProvinces && (
          <Place
            id="province"
            label="Province"
            value={province}
            onChange={pick(setProvince, [() => setCity('')])}
            places={[...(provinces.data?.places ?? []), ...(provinces.data?.independentCities ? [{ code: NO_PROVINCE, name: 'Independent city (no province)' }] : [])]}
          />
        )}
        <Place id="city" label="City or municipality" value={city} onChange={pick(setCity, [])} places={cities.data ?? []} disabled={!provinceKey} />
        <Place id="barangay" label="Barangay" value={barangayCode ?? ''} onChange={(v) => onChange({ street, barangayCode: v || null })} places={barangays.data ?? []} disabled={!city} />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="street">House no., street, building</Label>
        <Input id="street" value={street} aria-invalid={!!error} onChange={(e) => onChange({ street: e.target.value, barangayCode })} />
      </div>
      {error && <p className="text-destructive text-sm">{error}</p>}
    </fieldset>
  )
}

function Place({ id, label, value, onChange, places, disabled }: { id: string; label: string; value: string; onChange: (v: string) => void; places: { code: string; name: string }[]; disabled?: boolean }) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id} className="text-muted-foreground text-xs">
        {label}
      </Label>
      <NativeSelect id={id} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
        <option value="">Choose…</option>
        {places.map((p) => (
          <option key={p.code} value={p.code}>
            {p.name}
          </option>
        ))}
      </NativeSelect>
    </div>
  )
}
