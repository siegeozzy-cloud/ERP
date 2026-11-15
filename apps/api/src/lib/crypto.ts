import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { config } from '../config.ts'

/** A random secret for sessions and email links (256 bits, URL-safe). */
export const newToken = () => randomBytes(32).toString('base64url')

/** What's stored instead of the token itself, so a database leak doesn't hand out sessions. */
export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex')

/**
 * AES-256-GCM for sensitive values kept at rest: government ID numbers (TIN, SSS, PhilHealth,
 * Pag-IBIG) from Phase 1, as the Data Privacy Act expects. Format: "v1.<iv>.<tag>.<ciphertext>", base64url.
 */
export function encrypt(plain: string) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', config.encryptionKey, iv)
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return ['v1', iv, cipher.getAuthTag(), data].map((p) => (typeof p === 'string' ? p : p.toString('base64url'))).join('.')
}

export function decrypt(sealed: string) {
  const [v, iv, tag, data] = sealed.split('.')
  if (v !== 'v1' || !iv || !tag || !data) throw new Error('Unknown encryption format')
  const decipher = createDecipheriv('aes-256-gcm', config.encryptionKey, Buffer.from(iv, 'base64url'))
  decipher.setAuthTag(Buffer.from(tag, 'base64url'))
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8')
}
