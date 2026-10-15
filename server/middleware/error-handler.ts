import type { Context, ErrorHandler, NotFoundHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { ZodError } from 'zod';
import type { AppEnv } from '../env';
import { ApiError, MESSAGES, errors } from '../lib/errors';
import { zodFieldErrors } from '../lib/validation';

function render(c: Context<AppEnv>, err: ApiError) {
  if (err.retryAfterSeconds !== undefined) c.header('Retry-After', String(err.retryAfterSeconds));
  return c.json(err.toBody(), err.status);
}

/** Global error handler: known errors → envelope; everything else → generic 500 (never leaks e.message). */
export const onError: ErrorHandler<AppEnv> = (err, c) => {
  if (err instanceof ApiError) return render(c, err);
  if (err instanceof ZodError) return render(c, errors.validation(zodFieldErrors(err)));
  if (err instanceof HTTPException && err.status < 500) {
    if (err.status === 404) return render(c, errors.notFound());
    return render(c, new ApiError(err.status, 'VALIDATION_ERROR', MESSAGES.validation));
  }
  console.error('[api] unhandled error', c.req.method, new URL(c.req.url).pathname, err);
  return c.json({ error: { code: 'INTERNAL_ERROR', message: MESSAGES.internal } }, 500);
};

export const notFound: NotFoundHandler<AppEnv> = (c) => render(c, errors.notFound());
