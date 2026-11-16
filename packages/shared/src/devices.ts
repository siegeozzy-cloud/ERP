import { z } from 'zod'

/** A phone registering for push notifications. Expo hands each install a token like ExponentPushToken[abc…]. */
export const DeviceInput = z.object({
  token: z.string().regex(/^Expo(nent)?PushToken\[[A-Za-z0-9_-]{10,200}\]$/, 'That isn’t an Expo push token.'),
  platform: z.enum(['ios', 'android']),
})
export type DeviceInput = z.input<typeof DeviceInput>

/** What a notification carries for the app to act on when it's tapped. */
export type PushData = { workspaceId?: string; screen?: 'members' | 'home' | 'payslips' | 'leave' | 'approvals' | 'tasks' }
