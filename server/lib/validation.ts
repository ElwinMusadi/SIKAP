import type { z } from 'zod';
import { errors } from './errors';

/** Convert a zod error into `{ "a.b": "first message for that path" }`. Root issues use `_form`. */
export function zodFieldErrors(error: z.ZodError): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.length ? issue.path.map(String).join('.') : '_form';
    if (!(key in fields)) fields[key] = issue.message;
  }
  return fields;
}

/** Validate untrusted input; throws 400 VALIDATION_ERROR with a fields map on failure. */
export function parseWith<S extends z.ZodType>(schema: S, data: unknown): z.output<S> {
  const result = schema.safeParse(data);
  if (!result.success) throw errors.validation(zodFieldErrors(result.error));
  return result.data;
}

/** Read a JSON body; malformed JSON is a 400, never a 500. */
export async function readJson(req: { json: () => Promise<unknown> }): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    throw errors.validation(undefined, 'Body permintaan harus berupa JSON yang valid.');
  }
}
