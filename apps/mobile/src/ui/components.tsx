import type { ReactNode } from 'react'
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View, useColorScheme, type TextInputProps } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'

/** The same neutral palette as the web app, light and dark. */
const LIGHT = { bg: '#ffffff', fg: '#0a0a0a', muted: '#737373', card: '#fafafa', border: '#e5e5e5', primary: '#171717', primaryFg: '#fafafa', danger: '#dc2626', success: '#16a34a', input: '#ffffff' }
const DARK = { bg: '#0a0a0a', fg: '#fafafa', muted: '#a3a3a3', card: '#171717', border: '#262626', primary: '#e5e5e5', primaryFg: '#171717', danger: '#f87171', success: '#4ade80', input: '#171717' }
export type Colors = typeof LIGHT

export function useColors(): Colors {
  return useColorScheme() === 'dark' ? DARK : LIGHT
}

/** A scrolling page with safe-area padding. */
export function Screen({ children, refreshControl }: { children: ReactNode; refreshControl?: React.ReactElement }) {
  const c = useColors()
  return (
    <SafeAreaView edges={['bottom', 'left', 'right']} style={{ flex: 1, backgroundColor: c.bg }}>
      <ScrollView contentContainerStyle={styles.screen} keyboardShouldPersistTaps="handled" refreshControl={refreshControl as never}>
        {children}
      </ScrollView>
    </SafeAreaView>
  )
}

export function Title({ children, sub }: { children: ReactNode; sub?: ReactNode }) {
  const c = useColors()
  return (
    <View style={{ gap: 6, marginBottom: 8 }}>
      <Text style={[styles.title, { color: c.fg }]}>{children}</Text>
      {sub ? <Text style={[styles.body, { color: c.muted }]}>{sub}</Text> : null}
    </View>
  )
}

export function Body({ children, muted, style }: { children: ReactNode; muted?: boolean; style?: object }) {
  const c = useColors()
  return <Text style={[styles.body, { color: muted ? c.muted : c.fg }, style]}>{children}</Text>
}

export function Button({ title, onPress, variant = 'primary', busy, disabled }: { title: string; onPress: () => void; variant?: 'primary' | 'outline' | 'ghost'; busy?: boolean; disabled?: boolean }) {
  const c = useColors()
  const off = disabled || busy
  const bg = variant === 'primary' ? c.primary : 'transparent'
  const fg = variant === 'primary' ? c.primaryFg : c.fg
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!off, busy: !!busy }}
      onPress={onPress}
      disabled={off}
      style={({ pressed }) => [styles.button, { backgroundColor: bg, borderColor: variant === 'outline' ? c.border : 'transparent', opacity: off ? 0.6 : pressed ? 0.85 : 1 }]}
    >
      {busy ? <ActivityIndicator color={fg} /> : <Text style={[styles.buttonText, { color: fg }]}>{title}</Text>}
    </Pressable>
  )
}

/** A labelled text box with its error under it. */
export function Field({ label, error, hint, ...input }: TextInputProps & { label: string; error?: string; hint?: string }) {
  const c = useColors()
  return (
    <View style={{ gap: 6 }}>
      <Text style={[styles.label, { color: c.fg }]}>{label}</Text>
      <TextInput
        placeholderTextColor={c.muted}
        accessibilityLabel={label}
        {...input}
        style={[styles.input, { color: c.fg, backgroundColor: c.input, borderColor: error ? c.danger : c.border }, input.style]}
      />
      {error ? <Text style={[styles.small, { color: c.danger }]}>{error}</Text> : hint ? <Text style={[styles.small, { color: c.muted }]}>{hint}</Text> : null}
    </View>
  )
}

export function Card({ children, onPress }: { children: ReactNode; onPress?: () => void }) {
  const c = useColors()
  const style = [styles.card, { backgroundColor: c.card, borderColor: c.border }]
  return onPress ? (
    <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [...style, { opacity: pressed ? 0.8 : 1 }]}>
      {children}
    </Pressable>
  ) : (
    <View style={style}>{children}</View>
  )
}

export function ErrorBox({ message }: { message?: string | null }) {
  const c = useColors()
  if (!message) return null
  return (
    <View style={[styles.card, { borderColor: c.danger, backgroundColor: 'transparent' }]} accessibilityRole="alert">
      <Text style={[styles.body, { color: c.danger }]}>{message}</Text>
    </View>
  )
}

export function Stat({ label, value }: { label: string; value: string }) {
  const c = useColors()
  return (
    <View style={[styles.stat, { backgroundColor: c.card, borderColor: c.border }]}>
      <Text style={[styles.small, { color: c.muted }]}>{label}</Text>
      <Text style={[styles.statValue, { color: c.fg }]} numberOfLines={1} adjustsFontSizeToFit>
        {value}
      </Text>
    </View>
  )
}

export function Loading() {
  const c = useColors()
  return (
    <View style={{ paddingVertical: 48, alignItems: 'center' }}>
      <ActivityIndicator color={c.muted} />
    </View>
  )
}

/** The product mark, as on the web. */
export function Brand() {
  const c = useColors()
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
      <View style={{ width: 36, height: 36, borderRadius: 10, backgroundColor: c.primary, alignItems: 'center', justifyContent: 'center' }}>
        <Text style={{ color: c.primaryFg, fontWeight: '700', fontSize: 16 }}>E</Text>
      </View>
      <Text style={{ color: c.fg, fontSize: 22, fontWeight: '600' }}>ERP</Text>
    </View>
  )
}

export const styles = StyleSheet.create({
  screen: { padding: 20, gap: 16, paddingBottom: 48 },
  title: { fontSize: 26, fontWeight: '600' },
  body: { fontSize: 15, lineHeight: 22 },
  label: { fontSize: 14, fontWeight: '500' },
  small: { fontSize: 13, lineHeight: 18 },
  input: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 12, fontSize: 16 },
  button: { borderWidth: 1, borderRadius: 10, paddingVertical: 14, alignItems: 'center', justifyContent: 'center', minHeight: 50 },
  buttonText: { fontSize: 16, fontWeight: '600' },
  card: { borderWidth: 1, borderRadius: 14, padding: 16, gap: 6 },
  stat: { flexBasis: '47%', flexGrow: 1, borderWidth: 1, borderRadius: 14, padding: 14, gap: 4 },
  statValue: { fontSize: 20, fontWeight: '600' },
})
