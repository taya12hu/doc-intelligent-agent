import type { ApiErrorBody } from '@dia/shared';
import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';

/**
 * Errors.
 *
 * The important distinction this file encodes: a FAILED EXTRACTION IS NOT AN
 * ERROR. It is a legitimate, well-modelled outcome and it comes back as a 201
 * with `status: 'failed'` and the raw model output attached. Only genuine
 * faults — a bug, a dead upstream, a malformed request — reach here.
 *
 * Collapsing the two would mean the UI could not distinguish "the document
 * was unreadable" from "the server is broken", and those need very different
 * things from the person looking at the screen.
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  static badRequest(message: string, detail?: unknown) {
    return new ApiError(400, 'bad_request', message, detail);
  }
  static notFound(what: string) {
    return new ApiError(404, 'not_found', `${what} not found`);
  }
  static tooLarge(message: string) {
    return new ApiError(413, 'payload_too_large', message);
  }
  static unsupported(message: string) {
    return new ApiError(415, 'unsupported_media_type', message);
  }
}

export const errorHandler = (
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void => {
  if (err instanceof ApiError) {
    const body: ApiErrorBody = {
      error: {
        code: err.code,
        message: err.message,
        ...(err.detail !== undefined ? { detail: err.detail } : {}),
      },
    };
    res.status(err.status).json(body);
    return;
  }

  if (err instanceof ZodError) {
    res.status(400).json({
      error: {
        code: 'validation_failed',
        message: 'Request body did not match the expected shape',
        detail: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
    } satisfies ApiErrorBody);
    return;
  }

  // Anything reaching here is a bug or an outage. Log it in full; tell the
  // client only that something broke.
  console.error('[unhandled]', err);
  res.status(500).json({
    error: {
      code: 'internal_error',
      message: err instanceof Error ? err.message : 'Something went wrong',
    },
  } satisfies ApiErrorBody);
};
