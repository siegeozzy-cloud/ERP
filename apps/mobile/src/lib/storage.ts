import * as SecureStore from 'expo-secure-store'
import { Platform } from 'react-native'

/**
 * Small values kept on the phone: the session token and the last workspace. On a phone they go in
 * the system keychain (iOS) or keystore (Android), so other apps can't read the token. In the web
 * preview, which has no keychain, they go in the browser's storage.
 */

declare const localStorage: { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void } | undefined

const web = Platform.OS === 'web'

export const storage = {
  async get(key: string) {
    try {
      return web ? (localStorage?.getItem(key) ?? null) : await SecureStore.getItemAsync(key)
    } catch {
      return null
    }
  },
  async set(key: string, value: string) {
    try {
      if (web) localStorage?.setItem(key, value)
      else await SecureStore.setItemAsync(key, value)
    } catch {
      // nothing to do: the person signs in again next time
    }
  },
  async remove(key: string) {
    try {
      if (web) localStorage?.removeItem(key)
      else await SecureStore.deleteItemAsync(key)
    } catch {
      // already gone
    }
  },
}

export const KEYS = { token: 'erp.session', workspace: 'erp.workspace', pushToken: 'erp.pushToken' } as const
