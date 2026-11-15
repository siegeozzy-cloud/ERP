// Expo inlines EXPO_PUBLIC_* variables into the bundle at build time.
declare const process: { env: { EXPO_PUBLIC_API_URL?: string } }
