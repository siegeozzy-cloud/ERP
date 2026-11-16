import Constants from 'expo-constants'
import * as Device from 'expo-device'
import * as Notifications from 'expo-notifications'
import { Platform } from 'react-native'
import { api } from './api'
import { KEYS, storage } from './storage'

/**
 * Push notifications. They need three things the app can't provide by itself:
 * - a real phone (simulators and the web preview can't receive them),
 * - the person's permission, asked for the first time they turn them on,
 * - an EAS project id in app.json (`npx eas init` adds it), which Expo's push service needs.
 *
 * Expo Go can't receive pushes on Android, so test them in a development build (`npx eas build`).
 */

export type PushStatus = 'on' | 'denied' | 'unsupported' | 'needs-project'

if (Platform.OS !== 'web') {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false }),
  })
}

const projectId = () => (Constants.expoConfig?.extra?.eas?.projectId as string | undefined) ?? Constants.easConfig?.projectId

/** Asks for permission (if needed), gets this phone's token, and tells the API where to send. */
export async function enablePush(): Promise<PushStatus> {
  if (Platform.OS === 'web' || !Device.isDevice) return 'unsupported'
  if (!projectId()) return 'needs-project'

  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('default', { name: 'Updates', importance: Notifications.AndroidImportance.DEFAULT })
  }
  let { status } = await Notifications.getPermissionsAsync()
  if (status !== 'granted') status = (await Notifications.requestPermissionsAsync()).status
  if (status !== 'granted') return 'denied'

  const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId: projectId() })
  await api('/devices', { method: 'POST', body: { token, platform: Platform.OS } })
  await storage.set(KEYS.pushToken, token)
  return 'on'
}

/** On sign-out: this phone stops getting that person's notifications. */
export async function disablePush() {
  const token = await storage.get(KEYS.pushToken)
  if (!token) return
  await api('/devices', { method: 'DELETE', body: { token } }).catch(() => undefined)
  await storage.remove(KEYS.pushToken)
}

/** Whether this phone is set up to receive them already (no prompt). */
export async function pushStatus(): Promise<PushStatus> {
  if (Platform.OS === 'web' || !Device.isDevice) return 'unsupported'
  if (!projectId()) return 'needs-project'
  const { status } = await Notifications.getPermissionsAsync()
  if (status === 'denied') return 'denied'
  return (await storage.get(KEYS.pushToken)) ? 'on' : 'denied'
}
