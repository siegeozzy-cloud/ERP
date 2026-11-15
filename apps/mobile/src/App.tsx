import { APP_NAME } from '@erp/shared'
import { StatusBar } from 'expo-status-bar'
import { useCallback, useEffect, useState } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, useColorScheme, View } from 'react-native'
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context'
import { API_URL } from './config'

type Status = 'checking' | 'online' | 'offline'

/**
 * Phase 0: the phone app exists, reads the shared package, and can reach the API.
 * Sign-in, joining a workspace and the workspace switcher come in Phase 1M.
 */
export function App() {
  const dark = useColorScheme() === 'dark'
  const [status, setStatus] = useState<Status>('checking')

  const check = useCallback(async () => {
    setStatus('checking')
    try {
      const res = await fetch(`${API_URL}/api/ping`, { signal: AbortSignal.timeout(10_000) })
      setStatus(res.ok ? 'online' : 'offline')
    } catch {
      setStatus('offline')
    }
  }, [])

  useEffect(() => {
    void check()
  }, [check])

  const colors = dark ? { bg: '#0a0a0a', fg: '#fafafa', muted: '#a1a1a1', card: '#171717', border: '#262626' } : { bg: '#ffffff', fg: '#0a0a0a', muted: '#737373', card: '#fafafa', border: '#e5e5e5' }
  const dot = status === 'online' ? '#16a34a' : status === 'offline' ? '#dc2626' : colors.muted

  return (
    <SafeAreaProvider>
      <SafeAreaView style={[styles.screen, { backgroundColor: colors.bg }]}>
        <StatusBar style={dark ? 'light' : 'dark'} />
        <View style={styles.brand}>
          <View style={[styles.mark, { backgroundColor: colors.fg }]}>
            <Text style={[styles.markText, { color: colors.bg }]}>{APP_NAME.slice(0, 1)}</Text>
          </View>
          <Text style={[styles.title, { color: colors.fg }]}>{APP_NAME}</Text>
        </View>
        <Text style={[styles.lead, { color: colors.muted }]}>Sign-in, joining a workspace and clocking in arrive in the next phases.</Text>

        <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <View style={styles.row}>
            {status === 'checking' ? <ActivityIndicator size="small" /> : <View style={[styles.dot, { backgroundColor: dot }]} />}
            <Text style={[styles.cardTitle, { color: colors.fg }]}>
              {status === 'checking' ? 'Checking the server…' : status === 'online' ? 'Connected to the server' : 'Can’t reach the server'}
            </Text>
          </View>
          <Text style={[styles.small, { color: colors.muted }]}>{API_URL}</Text>
          {status === 'offline' && (
            <Pressable onPress={check} style={({ pressed }) => [styles.button, { backgroundColor: colors.fg, opacity: pressed ? 0.8 : 1 }]}>
              <Text style={[styles.buttonText, { color: colors.bg }]}>Try again</Text>
            </Pressable>
          )}
        </View>
      </SafeAreaView>
    </SafeAreaProvider>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, paddingHorizontal: 24, paddingTop: 48, gap: 16 },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  mark: { width: 36, height: 36, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  markText: { fontSize: 16, fontWeight: '700' },
  title: { fontSize: 24, fontWeight: '600' },
  lead: { fontSize: 15, lineHeight: 22 },
  card: { borderWidth: 1, borderRadius: 14, padding: 16, gap: 8, marginTop: 8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  cardTitle: { fontSize: 16, fontWeight: '600' },
  small: { fontSize: 13 },
  button: { marginTop: 8, borderRadius: 8, paddingVertical: 10, alignItems: 'center' },
  buttonText: { fontSize: 15, fontWeight: '600' },
})
