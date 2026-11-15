/**
 * Where the API is. The default reaches a laptop's API from the iOS simulator. Elsewhere, set
 * EXPO_PUBLIC_API_URL before `npm run dev:mobile`:
 *
 * - Android emulator: http://10.0.2.2:4100
 * - A real phone on the same Wi-Fi: http://<laptop's LAN IP>:4100, and start the API with HOST=0.0.0.0
 * - Deployed: the API's public address
 */
export const API_URL = (process.env.EXPO_PUBLIC_API_URL ?? 'http://127.0.0.1:4100').replace(/\/$/, '')
