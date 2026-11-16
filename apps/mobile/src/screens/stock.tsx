import { formatPeso, type ItemDetail, type StockLevel, type Warehouse } from '@erp/shared'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { CameraView, useCameraPermissions, type BarcodeScanningResult } from 'expo-camera'
import { useRef, useState } from 'react'
import { Platform, Pressable, Text, View } from 'react-native'
import { api, ApiError } from '../lib/api'
import { useSession } from '../lib/session'
import { Body, Button, Card, ErrorBox, Field, Screen, Title, useColors } from '../ui/components'
import type { SignedInStack } from './workspace'

type Props = NativeStackScreenProps<SignedInStack, 'Stock'>

const qty = new Intl.NumberFormat('en-PH', { maximumFractionDigits: 4 })
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date())

/**
 * Scan a barcode (or type it, or the SKU) to see how much of an item is where. Warehouse staff can
 * count a pile right there: the difference becomes a stock adjustment, books and all.
 */
export function StockScreen(_props: Props) {
  const c = useColors()
  const { state } = useSession()
  const workspaceId = state.status === 'signed-in' ? state.workspaceId : null
  const queryClient = useQueryClient()
  const [permission, requestPermission] = useCameraPermissions()
  const [scanning, setScanning] = useState(false)
  const [code, setCode] = useState('')
  const [item, setItem] = useState<ItemDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const lastScan = useRef(0)

  const ws = useQuery({ queryKey: ['w', workspaceId, 'workspace'], queryFn: async () => (await api<{ workspace: { permissions: string[] } }>(`/w/${workspaceId}`)).workspace, enabled: !!workspaceId })
  const canCount = ws.data?.permissions.includes('inventory.manage') ?? false
  const warehouses = useQuery({ queryKey: ['w', workspaceId, 'warehouses'], queryFn: async () => (await api<{ warehouses: Warehouse[] }>(`/w/${workspaceId}/warehouses`)).warehouses, enabled: !!workspaceId && canCount })

  async function lookUp(value: string) {
    const v = value.trim()
    if (!v) return
    setBusy(true)
    setError(null)
    try {
      setItem((await api<{ item: ItemDetail }>(`/w/${workspaceId}/items/barcode/${encodeURIComponent(v)}`)).item)
      setScanning(false)
    } catch (e) {
      setItem(null)
      setError(e instanceof ApiError && e.status === 404 ? `Nothing has the barcode or SKU “${v}”.` : (e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  function onScanned(result: BarcodeScanningResult) {
    // the camera reports the same code many times a second; take it once
    const now = Date.now()
    if (busy || now - lastScan.current < 2000) return
    lastScan.current = now
    setCode(result.data)
    void lookUp(result.data)
  }

  const cameraUsable = Platform.OS !== 'web'

  return (
    <Screen>
      <Title sub="Scan a barcode, or type it or the SKU.">Stock</Title>
      {cameraUsable && !scanning && (
        <Button
          title="Scan a barcode"
          onPress={() => {
            void (async () => {
              if (!permission?.granted && !(await requestPermission()).granted) return setError('The camera is off for this app. Turn it on in the phone’s Settings to scan.')
              setError(null)
              setScanning(true)
            })()
          }}
        />
      )}
      {scanning && (
        <View style={{ gap: 10 }}>
          <View style={{ height: 260, borderRadius: 14, overflow: 'hidden', borderWidth: 1, borderColor: c.border }}>
            <CameraView
              style={{ flex: 1 }}
              facing="back"
              barcodeScannerSettings={{ barcodeTypes: ['ean13', 'ean8', 'upc_a', 'upc_e', 'code128', 'code39', 'qr'] }}
              onBarcodeScanned={onScanned}
            />
          </View>
          <Button title="Stop scanning" variant="outline" onPress={() => setScanning(false)} />
        </View>
      )}
      <Field label="Barcode or SKU" value={code} onChangeText={setCode} autoCapitalize="characters" autoCorrect={false} onSubmitEditing={() => void lookUp(code)} />
      <Button title="Find" variant="outline" busy={busy} onPress={() => void lookUp(code)} />
      <ErrorBox message={error} />
      {item && (
        <ItemCard
          item={item}
          workspaceId={workspaceId!}
          canCount={canCount}
          warehouses={warehouses.data ?? []}
          onCounted={async () => {
            await queryClient.invalidateQueries({ queryKey: ['w', workspaceId] })
            await lookUp(item.sku)
          }}
        />
      )}
    </Screen>
  )
}

type Pile = { warehouseId: string; warehouseName: string; lotNo: string | null; quantity: number }

function ItemCard({ item, workspaceId, canCount, warehouses, onCounted }: { item: ItemDetail; workspaceId: string; canCount: boolean; warehouses: Warehouse[]; onCounted: () => Promise<void> }) {
  const c = useColors()
  const [chosen, setChosen] = useState<Pile | null>(null)
  const [counted, setCounted] = useState('')
  const [lotNo, setLotNo] = useState('')
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // the piles to count: what's recorded, plus open warehouses with none (a lot-less item may turn up there)
  const piles: Pile[] = item.levels.map((l: StockLevel) => ({ warehouseId: l.warehouse.id, warehouseName: l.warehouse.name, lotNo: l.lot?.lotNo ?? null, quantity: l.quantity }))
  if (!item.trackLots) for (const w of warehouses.filter((w) => w.active && !piles.some((p) => p.warehouseId === w.id))) piles.push({ warehouseId: w.id, warehouseName: w.name, lotNo: null, quantity: 0 })

  async function saveCount() {
    const n = Number(counted)
    if (!counted.trim() || !Number.isFinite(n) || n < 0) return setError('Enter how many are on the shelf.')
    if (!chosen) return
    const lot = chosen.lotNo ?? (item.trackLots ? lotNo.trim() : '')
    if (item.trackLots && !lot) return setError('Enter the lot number.')
    setBusy(true)
    setError(null)
    try {
      await api(`/w/${workspaceId}/stock/adjustments`, {
        method: 'POST',
        body: { date: today(), warehouseId: chosen.warehouseId, reason: 'count', lines: [{ itemId: item.id, counted: n, lotNo: lot || undefined }] },
      })
      const diff = n - chosen.quantity
      setMessage(diff === 0 ? 'Counted: matches the books.' : `Counted: ${diff > 0 ? '+' : ''}${qty.format(diff)} ${item.unit.code}, adjusted.`)
      setChosen(null)
      setCounted('')
      await onCounted()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <View style={{ gap: 12 }}>
      <Card>
        <Body style={{ fontWeight: '600', fontSize: 18 }}>{item.name}</Body>
        <Body muted>
          {item.sku}
          {item.barcode ? ` · ${item.barcode}` : ''}
        </Body>
        {item.kind === 'stock' ? (
          <Text style={{ color: item.low ? c.danger : c.fg, fontSize: 28, fontWeight: '600', marginTop: 4 }}>
            {qty.format(item.onHand)} {item.unit.code}
          </Text>
        ) : (
          <Body muted>A service: not counted.</Body>
        )}
        {item.low && <Body style={{ color: c.danger }}>Running low (reorder at {qty.format(item.reorderPoint)})</Body>}
        <Body muted>Sells for {formatPeso(item.salesPrice)}</Body>
      </Card>
      {message ? (
        <Card>
          <Body style={{ color: c.success }}>{message}</Body>
        </Card>
      ) : null}
      {item.kind === 'stock' && (
        <>
          <Text style={{ color: c.fg, fontSize: 17, fontWeight: '600' }}>Where it is{canCount ? ' (tap to count)' : ''}</Text>
          {piles.length === 0 && <Body muted>None in stock.</Body>}
          {piles.map((p) => {
            const selected = chosen?.warehouseId === p.warehouseId && chosen?.lotNo === p.lotNo
            return (
              <Pressable
                key={`${p.warehouseId}-${p.lotNo ?? ''}`}
                disabled={!canCount}
                accessibilityRole={canCount ? 'button' : undefined}
                onPress={() => {
                  setChosen(selected ? null : p)
                  setCounted('')
                  setMessage(null)
                }}
                style={{ borderWidth: selected ? 2 : 1, borderColor: selected ? c.fg : c.border, borderRadius: 12, padding: 14, flexDirection: 'row', justifyContent: 'space-between', gap: 12 }}
              >
                <View style={{ flexShrink: 1 }}>
                  <Body>{p.warehouseName}</Body>
                  {p.lotNo && <Body muted>Lot {p.lotNo}</Body>}
                </View>
                <Body style={{ fontVariant: ['tabular-nums'] }}>
                  {qty.format(p.quantity)} {item.unit.code}
                </Body>
              </Pressable>
            )
          })}
          {canCount && item.trackLots && warehouses.length > 0 && !chosen && (
            <Body muted>To count a lot that isn’t listed, tap a warehouse’s pile and enter its lot number.</Body>
          )}
          {chosen && (
            <Card>
              <Body style={{ fontWeight: '600' }}>
                Count at {chosen.warehouseName}
                {chosen.lotNo ? `, lot ${chosen.lotNo}` : ''}
              </Body>
              {item.trackLots && !chosen.lotNo && <Field label="Lot number" value={lotNo} onChangeText={setLotNo} autoCapitalize="characters" />}
              <Field label={`On the shelf (${item.unit.code})`} value={counted} onChangeText={setCounted} keyboardType="decimal-pad" onSubmitEditing={() => void saveCount()} />
              <ErrorBox message={error} />
              <Button title="Save count" busy={busy} onPress={() => void saveCount()} />
            </Card>
          )}
        </>
      )}
    </View>
  )
}
