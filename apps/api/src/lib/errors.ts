import type { ApiErrorBody } from '@erp/shared'
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify'
import type { z } from 'zod'

/**
 * Every error the API sends looks like { error: { code, message, field? } } (ApiErrorBody).
 * `message` is written for people (the apps show it as is); `field` names the form input it's about.
 */
export class HttpError extends Error {
  readonly status: number
  readonly code: string
  readonly field?: string

  constructor(status: number, code: string, message: string, field?: string) {
    super(message)
    this.status = status
    this.code = code
    this.field = field
  }
}

/** Validates a request body or query; the first problem becomes a 400 pointing at its field. */
export function parse<S extends z.ZodType>(schema: S, data: unknown): z.output<S> {
  const r = schema.safeParse(data ?? {})
  if (r.success) return r.data
  const issue = r.error.issues[0]!
  const field = typeof issue.path[0] === 'string' ? issue.path[0] : undefined
  const message = issue.code === 'invalid_type' && issue.input === undefined ? `${field ?? 'A value'} is missing.` : issue.message
  throw new HttpError(400, 'invalid', message, field)
}

const send = (reply: FastifyReply, status: number, error: ApiErrorBody['error']) => reply.code(status).send({ error } satisfies ApiErrorBody)

/** A refusal from one of the database's own rules (migration 0002: posted records are final). */
function databaseRefusal(err: unknown) {
  const cause = ((err as { cause?: unknown })?.cause ?? err) as { code?: string; message?: string }
  return cause?.code === 'P0001' ? cause.message : undefined
}

export function errorHandler(err: FastifyError | HttpError, req: FastifyRequest, reply: FastifyReply) {
  if (err instanceof HttpError) return send(reply, err.status, { code: err.code, message: err.message, field: err.field })
  const refused = databaseRefusal(err)
  if (refused) return send(reply, 409, { code: 'locked', message: refused })
  if (err.statusCode === 429) return send(reply, 429, { code: 'rate-limited', message: 'Too many attempts. Wait a minute and try again.' })
  if (err.statusCode && err.statusCode < 500) return send(reply, err.statusCode, { code: 'bad-request', message: 'That request wasn’t understood.' })
  req.log.error(err)
  return send(reply, 500, { code: 'server', message: 'Something went wrong on our side. Try again.' })
}
