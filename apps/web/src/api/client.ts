import type {
  ApiErrorBody,
  CreateLineItem,
  DocumentListItem,
  FullRecord,
  PatchExtraction,
  PatchLineItem,
} from '@dia/shared';

/**
 * Typed fetch wrapper.
 *
 * The DTOs come from `@dia/shared`, so the API's response shape and the
 * components' expectations are the same declaration. A field renamed on the
 * server is a compile error here rather than an `undefined` in the UI.
 */

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
  }
}

const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body && !(init.body instanceof FormData)
        ? { 'Content-Type': 'application/json' }
        : {}),
      ...init?.headers,
    },
  });

  if (!response.ok) {
    let body: ApiErrorBody | undefined;
    try {
      body = (await response.json()) as ApiErrorBody;
    } catch {
      /* the server did not send JSON; fall through to a generic message */
    }
    throw new ApiRequestError(
      response.status,
      body?.error.code ?? 'unknown',
      body?.error.message ?? `Request failed (${response.status})`,
      body?.error.detail,
    );
  }

  return response.json() as Promise<T>;
};

export const api = {
  listDocuments: () => request<DocumentListItem[]>('/api/documents'),

  getRecord: (id: string) => request<FullRecord>(`/api/documents/${id}`),

  upload: (file: File) => {
    const form = new FormData();
    form.append('file', file);
    return request<FullRecord>('/api/documents', { method: 'POST', body: form });
  },

  reextract: (documentId: string) =>
    request<FullRecord>(`/api/documents/${documentId}/reextract`, { method: 'POST' }),

  patchExtraction: (id: string, patch: PatchExtraction) =>
    request<FullRecord>(`/api/extractions/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  patchLineItem: (id: string, patch: PatchLineItem) =>
    request<FullRecord>(`/api/line-items/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  addLineItem: (extractionId: string, values: Partial<CreateLineItem> = {}) =>
    request<FullRecord>(`/api/extractions/${extractionId}/line-items`, {
      method: 'POST',
      body: JSON.stringify(values),
    }),

  deleteLineItem: (id: string) =>
    request<FullRecord>(`/api/line-items/${id}`, { method: 'DELETE' }),

  markReviewed: (extractionId: string) =>
    request<FullRecord>(`/api/extractions/${extractionId}/review`, { method: 'POST' }),

  fileUrl: (documentId: string) => `/api/documents/${documentId}/file`,
};
