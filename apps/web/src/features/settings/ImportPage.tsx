import { IMPORT_COLUMNS, IMPORT_LABELS, templateByKey, type ImportColumn, type ImportKind, type ImportResult } from '@erp/shared'
import { CheckCircle2, Download, FileSpreadsheet, Upload } from 'lucide-react'
import { useState } from 'react'
import { FormError } from '@/components/form'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { PageHeader } from '@/features/finance/components'
import { useWorkspaceMutation } from '@/features/finance/queries'
import { useCan, useWorkspace } from '@/features/workspaces/queries'
import { api } from '@/lib/api'
import { today } from '@/lib/dates'
import { cn } from '@/lib/utils'

/**
 * Excel import (Phase 9): items, customers and suppliers, and opening stock, from .xlsx or .csv.
 * The sheet is read here in the browser (ExcelJS loads only on this page); the API checks every row
 * and saves all of them or none. A check comes first, so nothing is saved until the sheet is clean.
 */

type Row = Record<string, string>

/** The columns for a kind, plus (for items) the workspace template's own fields. */
function columnsFor(kind: ImportKind, template: string): ImportColumn[] {
  const base = IMPORT_COLUMNS[kind]
  if (kind !== 'items') return base
  return [...base, ...(templateByKey(template)?.itemFields ?? []).map((f) => ({ key: `attr:${f.key}`, header: f.label, example: f.options?.[0] ?? '', hint: f.options ? `One of: ${f.options.join(', ')}` : f.hint }))]
}

/** A cell's value as text: dates as YYYY-MM-DD, formulas as their result. */
function cellText(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  if (typeof v === 'object') {
    const o = v as { result?: unknown; richText?: { text: string }[]; text?: string; hyperlink?: string }
    if ('result' in o) return cellText(o.result)
    if (o.richText) return o.richText.map((t) => t.text).join('')
    if (o.text !== undefined) return String(o.text)
    if (o.hyperlink) return o.hyperlink
  }
  return String(v).trim()
}

/** A CSV file as rows of cells (quotes and commas inside quotes handled). */
function parseCsv(text: string): string[][] {
  const out: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"'
        i++
      } else if (ch === '"') quoted = false
      else cell += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') {
      row.push(cell)
      cell = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(cell)
      out.push(row)
      row = []
      cell = ''
    } else cell += ch
  }
  if (cell || row.length) {
    row.push(cell)
    out.push(row)
  }
  return out.filter((r) => r.some((c) => c.trim()))
}

async function readSheet(file: File): Promise<string[][]> {
  if (/\.csv$/i.test(file.name)) return parseCsv((await file.text()).replace(/^﻿/, ''))
  const ExcelJS = (await import('exceljs')).default
  const book = new ExcelJS.Workbook()
  await book.xlsx.load(await file.arrayBuffer())
  const sheet = book.worksheets[0]
  if (!sheet) return []
  const rows: string[][] = []
  sheet.eachRow({ includeEmpty: false }, (r) => {
    const cells: string[] = []
    r.eachCell({ includeEmpty: true }, (c, col) => {
      cells[col - 1] = cellText(c.value)
    })
    rows.push(Array.from(cells, (c) => c ?? ''))
  })
  return rows
}

async function downloadTemplate(kind: ImportKind, columns: ImportColumn[]) {
  const ExcelJS = (await import('exceljs')).default
  const book = new ExcelJS.Workbook()
  const sheet = book.addWorksheet(IMPORT_LABELS[kind])
  sheet.addRow(columns.map((c) => c.header))
  sheet.addRow(columns.map((c) => c.example))
  sheet.getRow(1).font = { bold: true }
  columns.forEach((c, i) => {
    sheet.getColumn(i + 1).width = Math.max(12, c.header.length + 4)
    if (c.hint || c.required) sheet.getCell(1, i + 1).note = [c.required ? 'Required.' : '', c.hint ?? ''].filter(Boolean).join(' ')
  })
  const notes = book.addWorksheet('How to fill it in')
  notes.addRow(['Column', 'Required', 'What goes in it'])
  notes.getRow(1).font = { bold: true }
  for (const c of columns) notes.addRow([c.header, c.required ? 'yes' : '', c.hint ?? `e.g. ${c.example}`])
  notes.getColumn(1).width = 28
  notes.getColumn(3).width = 60
  const blob = new Blob([await book.xlsx.writeBuffer()], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
  const url = URL.createObjectURL(blob)
  Object.assign(document.createElement('a'), { href: url, download: `${kind}-template.xlsx` }).click()
  URL.revokeObjectURL(url)
}

export function ImportPage() {
  const workspace = useWorkspace()
  const can = useCan()
  const kinds = (['items', 'contacts', 'opening-stock'] as const).filter((k) =>
    k === 'contacts' ? can('finance.edit') || can('crm.manage') : workspace.modules.includes('inventory') && can('inventory.manage'),
  )
  const [kind, setKind] = useState<ImportKind | undefined>(kinds[0])
  const [rows, setRows] = useState<Row[] | null>(null)
  const [ignored, setIgnored] = useState<string[]>([])
  const [fileName, setFileName] = useState('')
  const [date, setDate] = useState(today())
  const [result, setResult] = useState<ImportResult | null>(null)
  const [error, setError] = useState<string>()
  const send = useWorkspaceMutation((w, { dryRun }: { dryRun: boolean }) => api<{ result: ImportResult }>(`/w/${w}/import/${kind}`, { method: 'POST', body: { rows, dryRun, date } }))

  if (!kind) return <PageHeader title="Import" description="Your role can’t import anything here." />
  const columns = columnsFor(kind, workspace.template)

  async function pick(file: File) {
    setError(undefined)
    setResult(null)
    setFileName(file.name)
    try {
      const sheet = await readSheet(file)
      const [header, ...body] = sheet
      if (!header) throw new Error('The sheet is empty.')
      const byHeader = new Map(columns.flatMap((c) => [[c.header.toLowerCase(), c.key] as const, [c.key.toLowerCase(), c.key] as const]))
      const keys = header.map((h) => byHeader.get(h.trim().toLowerCase()))
      const missing = columns.filter((c) => c.required && !keys.includes(c.key))
      if (missing.length) throw new Error(`The first row needs these columns: ${missing.map((c) => c.header).join(', ')}.`)
      setIgnored(header.filter((h, i) => h.trim() && !keys[i]))
      setRows(body.map((cells) => Object.fromEntries(keys.flatMap((k, i) => (k ? [[k, cells[i] ?? '']] : [])))))
    } catch (e) {
      setRows(null)
      setError((e as Error).message)
    }
  }

  const check = (dryRun: boolean) =>
    send.mutate(
      { dryRun },
      {
        onSuccess: (r) => {
          setResult(r.result)
          if (r.result.saved) setRows(null)
        },
        onError: (e) => setError(e.message),
      },
    )

  const shown = columns.filter((c) => rows?.some((r) => r[c.key]))
  return (
    <div className="space-y-6">
      <PageHeader title="Import from Excel" description="Bring in what you have in spreadsheets: an .xlsx or .csv file, one row per record. Everything is checked first; nothing is saved until every row is right." />
      <div className="grid gap-3 sm:grid-cols-3">
        {kinds.map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => (setKind(k), setRows(null), setResult(null), setError(undefined))}
            className={cn('rounded-xl border p-4 text-left transition-colors', k === kind ? 'border-foreground ring-foreground/10 ring-2' : 'hover:border-foreground/30')}
          >
            <FileSpreadsheet className="mb-2 size-5" />
            <p className="font-medium">{IMPORT_LABELS[k]}</p>
            <p className="text-muted-foreground text-sm">
              {k === 'items' ? 'New items are added; a SKU you already have is updated.' : k === 'contacts' ? 'A name you already have is updated.' : 'Quantities on hand and their cost, as of a date.'}
            </p>
          </button>
        ))}
      </div>

      <Card>
        <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
          <div className="space-y-1.5">
            <CardTitle>{IMPORT_LABELS[kind]}</CardTitle>
            <CardDescription>
              Columns: {columns.map((c) => `${c.header}${c.required ? '*' : ''}`).join(', ')}. * required.
            </CardDescription>
          </div>
          <Button variant="outline" onClick={() => void downloadTemplate(kind, columns)}>
            <Download />
            Download a template
          </Button>
        </CardHeader>
        <CardContent className="grid gap-4">
          <div className="flex flex-wrap items-end gap-4">
            <div className="grid gap-2">
              <Label htmlFor="imp-file">Spreadsheet</Label>
              <Input id="imp-file" type="file" accept=".xlsx,.csv" className="max-w-sm" onChange={(e) => e.target.files?.[0] && void pick(e.target.files[0])} />
            </div>
            {kind === 'opening-stock' && (
              <div className="grid gap-2">
                <Label htmlFor="imp-date">Counted as of</Label>
                <Input id="imp-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} className="w-44" />
              </div>
            )}
          </div>
          <FormError message={error} />
          {ignored.length > 0 && <p className="text-muted-foreground text-sm">Not imported (no such column): {ignored.join(', ')}.</p>}

          {rows && (
            <>
              <p className="text-sm">
                {fileName}: <strong>{rows.length}</strong> row{rows.length === 1 ? '' : 's'}.
              </p>
              <div className="max-h-80 overflow-auto rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-14">Row</TableHead>
                      {shown.map((c) => (
                        <TableHead key={c.key}>{c.header}</TableHead>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.slice(0, 50).map((r, i) => {
                      const bad = result?.errors.find((e) => e.row === i + 2)
                      return (
                        <TableRow key={i} className={cn(bad && 'bg-destructive/5')}>
                          <TableCell className="text-muted-foreground tabular-nums">{i + 2}</TableCell>
                          {shown.map((c) => (
                            <TableCell key={c.key} className="whitespace-nowrap">
                              {r[c.key]}
                            </TableCell>
                          ))}
                        </TableRow>
                      )
                    })}
                  </TableBody>
                </Table>
              </div>
              {rows.length > 50 && <p className="text-muted-foreground text-xs">Showing the first 50.</p>}
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" disabled={send.isPending} onClick={() => check(true)}>
                  Check
                </Button>
                <Button disabled={send.isPending || !result || result.errors.length > 0} onClick={() => check(false)}>
                  <Upload />
                  Import {rows.length} row{rows.length === 1 ? '' : 's'}
                </Button>
              </div>
            </>
          )}

          {result && result.errors.length > 0 && (
            <div className="border-destructive/40 grid gap-1 rounded-md border p-3 text-sm">
              <p className="text-destructive font-medium">Fix these in the sheet and choose it again. Nothing was saved.</p>
              {result.errors.map((e, i) => (
                <p key={i}>
                  <span className="text-muted-foreground">Row {e.row}:</span> {e.message}
                </p>
              ))}
            </div>
          )}
          {result && result.errors.length === 0 && (
            <p className="text-success flex items-center gap-2 text-sm">
              <CheckCircle2 className="size-4" />
              {result.saved ? `Imported: ${result.created} new, ${result.updated} updated.` : `Every row is fine: ${result.created} to add, ${result.updated} to update. Import when ready.`}
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
