import { formatPeso } from '@erp/shared'
import { useState, type ReactNode } from 'react'
import { cn } from '@/lib/utils'

// Small SVG charts for the dashboard (Phase 9), with no chart library: thin marks, rounded data
// ends on the baseline, a 2px gap between bars, recessive gridlines, a tooltip on hover (and on
// focus, for keyboards), a legend when there's more than one series, and a table for screen
// readers. Series colours come from --series-1/2 (validated for both themes in index.css).

const SERIES = ['var(--series-1)', 'var(--series-2)']

/** ₱1.2M, ₱850K, ₱900: for axis ticks, where the full amount is in the tooltip. */
export function compactPeso(centavos: number) {
  const p = centavos / 100
  const a = Math.abs(p)
  const s = a >= 1_000_000 ? `${(a / 1_000_000).toFixed(a >= 10_000_000 ? 0 : 1)}M` : a >= 1_000 ? `${Math.round(a / 1_000)}K` : `${Math.round(a)}`
  return `${p < 0 ? '−' : ''}₱${s.replace('.0M', 'M')}`
}

/** Round gridline steps that cover the data: 0, 500K, 1M, 1.5M… */
function ticks(min: number, max: number, count = 4) {
  const span = Math.max(max - Math.min(0, min), 1)
  const raw = span / count
  const mag = 10 ** Math.floor(Math.log10(raw))
  const step = ([1, 2, 2.5, 5, 10].find((m) => m * mag >= raw) ?? 10) * mag
  const lo = Math.floor(Math.min(0, min) / step) * step
  const out: number[] = []
  for (let v = lo; v <= max + step * 0.001; v += step) out.push(v)
  if (out.at(-1)! < max) out.push(out.at(-1)! + step)
  return out
}

export function Legend({ items }: { items: { label: string; color: string }[] }) {
  return (
    <div className="text-muted-foreground flex flex-wrap gap-4 text-xs">
      {items.map((i) => (
        <span key={i.label} className="inline-flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm" style={{ background: i.color }} />
          {i.label}
        </span>
      ))}
    </div>
  )
}

/** A tooltip at a point given as a share of the chart's width and height (the SVG scales with the page). */
function Tooltip({ x, y, children }: { x: number; y: number; children: ReactNode }) {
  return (
    <div
      className="bg-popover text-popover-foreground pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full rounded-md border px-2.5 py-1.5 text-xs whitespace-nowrap shadow-md"
      style={{ left: `${Math.min(Math.max(x * 100, 14), 86)}%`, top: `calc(${y * 100}% - 8px)` }}
    >
      {children}
    </div>
  )
}

const H = 200
const PAD = { top: 12, right: 18, bottom: 24, left: 52 }

/** Bars by month, one or two series side by side (same scale: never two axes). */
export function MonthBars({ data, series, label }: { data: { label: string; values: number[] }[]; series: string[]; label: string }) {
  const [hover, setHover] = useState<number | null>(null)
  const W = 560
  const all = data.flatMap((d) => d.values)
  const t = ticks(Math.min(0, ...all), Math.max(1, ...all))
  const lo = t[0]!
  const hi = t.at(-1)!
  const y = (v: number) => PAD.top + ((hi - v) / (hi - lo)) * (H - PAD.top - PAD.bottom)
  const band = (W - PAD.left - PAD.right) / data.length
  const gap = 2
  const barW = Math.min(28, (band * 0.62 - gap * (series.length - 1)) / series.length)
  const group = barW * series.length + gap * (series.length - 1)
  const zero = y(0)
  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={label} onMouseLeave={() => setHover(null)}>
        {t.map((v) => (
          <g key={v}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(v)} y2={y(v)} className={v === 0 ? 'stroke-foreground/40' : 'stroke-border'} strokeWidth={1} />
            <text x={PAD.left - 6} y={y(v)} dy="0.32em" textAnchor="end" className="fill-muted-foreground text-[10px]">
              {compactPeso(v)}
            </text>
          </g>
        ))}
        {data.map((d, i) => {
          const x0 = PAD.left + band * i + (band - group) / 2
          return (
            <g key={d.label}>
              {d.values.map((v, s) => {
                const top = Math.min(y(v), zero)
                const h = Math.max(Math.abs(zero - y(v)), v === 0 ? 0 : 1)
                const r = Math.min(4, h, barW / 2)
                const x = x0 + s * (barW + gap)
                // rounded at the data end only: the end away from the baseline
                const path =
                  v >= 0
                    ? `M${x},${top + h} V${top + r} Q${x},${top} ${x + r},${top} H${x + barW - r} Q${x + barW},${top} ${x + barW},${top + r} V${top + h} Z`
                    : `M${x},${top} V${top + h - r} Q${x},${top + h} ${x + r},${top + h} H${x + barW - r} Q${x + barW},${top + h} ${x + barW},${top + h - r} V${top} Z`
                return <path key={s} d={path} fill={SERIES[s]} opacity={hover === null || hover === i ? 1 : 0.45} />
              })}
              <text x={PAD.left + band * i + band / 2} y={H - 8} textAnchor="middle" className="fill-muted-foreground text-[11px]">
                {d.label}
              </text>
              {/* the hit area is the whole month, bigger than the bars */}
              <rect
                x={PAD.left + band * i}
                y={PAD.top}
                width={band}
                height={H - PAD.top - PAD.bottom}
                fill="transparent"
                tabIndex={0}
                aria-label={`${d.label}: ${series.map((s, k) => `${s} ${formatPeso(d.values[k] ?? 0)}`).join(', ')}`}
                onMouseEnter={() => setHover(i)}
                onFocus={() => setHover(i)}
                onBlur={() => setHover(null)}
                className="focus:outline-none"
              />
            </g>
          )
        })}
      </svg>
      {hover !== null && (
        <Tooltip x={(PAD.left + band * hover + band / 2) / W} y={Math.min(...data[hover]!.values.map(y), zero) / H}>
          <p className="mb-1 font-medium">{data[hover]!.label}</p>
          {series.map((s, k) => (
            <p key={s} className="flex items-center gap-1.5 tabular-nums">
              <span className="size-2 rounded-sm" style={{ background: SERIES[k] }} />
              {s} {formatPeso(data[hover]!.values[k] ?? 0)}
            </p>
          ))}
        </Tooltip>
      )}
      <table className="sr-only">
        <caption>{label}</caption>
        <thead>
          <tr>
            <th>Month</th>
            {series.map((s) => (
              <th key={s}>{s}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.map((d) => (
            <tr key={d.label}>
              <th>{d.label}</th>
              {d.values.map((v, k) => (
                <td key={k}>{formatPeso(v)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** One series over time: a 2px line, a crosshair and a marker on hover. */
export function TrendLine({ data, label }: { data: { label: string; value: number }[]; label: string }) {
  const [hover, setHover] = useState<number | null>(null)
  const W = 560
  const vals = data.map((d) => d.value)
  const t = ticks(Math.min(0, ...vals), Math.max(1, ...vals))
  const lo = t[0]!
  const hi = t.at(-1)!
  const y = (v: number) => PAD.top + ((hi - v) / (hi - lo)) * (H - PAD.top - PAD.bottom)
  const step = (W - PAD.left - PAD.right) / Math.max(1, data.length - 1)
  const x = (i: number) => PAD.left + step * i
  const path = data.map((d, i) => `${i ? 'L' : 'M'}${x(i)},${y(d.value)}`).join(' ')
  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={label} onMouseLeave={() => setHover(null)}>
        {t.map((v) => (
          <g key={v}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(v)} y2={y(v)} className={v === 0 ? 'stroke-foreground/40' : 'stroke-border'} strokeWidth={1} />
            <text x={PAD.left - 6} y={y(v)} dy="0.32em" textAnchor="end" className="fill-muted-foreground text-[10px]">
              {compactPeso(v)}
            </text>
          </g>
        ))}
        <path d={path} fill="none" stroke={SERIES[0]} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        {hover !== null && (
          <>
            <line x1={x(hover)} x2={x(hover)} y1={PAD.top} y2={H - PAD.bottom} className="stroke-foreground/30" strokeDasharray="3 3" />
            <circle cx={x(hover)} cy={y(data[hover]!.value)} r={4.5} fill={SERIES[0]} className="stroke-card" strokeWidth={2} />
          </>
        )}
        {data.map((d, i) => (
          <g key={d.label}>
            <text x={x(i)} y={H - 8} textAnchor="middle" className="fill-muted-foreground text-[11px]">
              {d.label}
            </text>
            <rect
              x={x(i) - step / 2}
              y={PAD.top}
              width={step}
              height={H - PAD.top - PAD.bottom}
              fill="transparent"
              tabIndex={0}
              aria-label={`${d.label}: ${formatPeso(d.value)}`}
              onMouseEnter={() => setHover(i)}
              onFocus={() => setHover(i)}
              onBlur={() => setHover(null)}
              className="focus:outline-none"
            />
          </g>
        ))}
      </svg>
      {hover !== null && (
        <Tooltip x={x(hover) / W} y={y(data[hover]!.value) / H}>
          <p className="font-medium">{data[hover]!.label}</p>
          <p className="tabular-nums">{formatPeso(data[hover]!.value)}</p>
        </Tooltip>
      )}
      <table className="sr-only">
        <caption>{label}</caption>
        <tbody>
          {data.map((d) => (
            <tr key={d.label}>
              <th>{d.label}</th>
              <td>{formatPeso(d.value)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** Ranked or ordered amounts as horizontal bars, each labelled with its value. */
export function AmountBars({ data, label, emphasis }: { data: { key: string; label: ReactNode; value: number; note?: string }[]; label: string; emphasis?: (key: string) => boolean }) {
  const max = Math.max(1, ...data.map((d) => d.value))
  return (
    <div role="list" aria-label={label} className="grid gap-2.5">
      {data.map((d) => (
        <div role="listitem" key={d.key} className="grid gap-1" title={d.note}>
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span className={cn('min-w-0 truncate', emphasis?.(d.key) && 'font-medium')}>{d.label}</span>
            <span className="tabular-nums">
              {formatPeso(d.value)}
              {d.note && <span className="text-muted-foreground ml-1.5 text-xs">{d.note}</span>}
            </span>
          </div>
          <div className="bg-muted h-2 overflow-hidden rounded-full">
            <div className="h-full rounded-full" style={{ width: `${(d.value / max) * 100}%`, background: SERIES[0] }} />
          </div>
        </div>
      ))}
    </div>
  )
}
