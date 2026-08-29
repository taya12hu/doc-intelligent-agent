import type { FullRecord } from '@dia/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client.js';

export const keys = {
  documents: ['documents'] as const,
  record: (id: string) => ['record', id] as const,
};

export const useDocuments = () =>
  useQuery({ queryKey: keys.documents, queryFn: api.listDocuments });

export const useRecord = (id: string) =>
  useQuery({ queryKey: keys.record(id), queryFn: () => api.getRecord(id) });

/**
 * Every mutation returns the whole record, and we write it straight into the
 * cache rather than invalidating and refetching.
 *
 * That matters more than it looks: a correction changes flags, confidence and
 * status server-side, and the reviewer needs to SEE those clear. Writing the
 * authoritative response into the cache means the amber ring disappears the
 * instant the server agrees it should — no refetch flicker, no window where
 * the UI shows a stale flag next to a corrected value.
 */
const useRecordMutation = <TArgs>(fn: (args: TArgs) => Promise<FullRecord>) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (record) => {
      queryClient.setQueryData(keys.record(record.document.id), record);
      void queryClient.invalidateQueries({ queryKey: keys.documents });
    },
  });
};

export const useUpload = () => useRecordMutation((file: File) => api.upload(file));

export const useReextract = (documentId: string) =>
  useRecordMutation(() => api.reextract(documentId));

export const usePatchExtraction = (extractionId: string) =>
  useRecordMutation((patch: Parameters<typeof api.patchExtraction>[1]) =>
    api.patchExtraction(extractionId, patch),
  );

export const usePatchLineItem = () =>
  useRecordMutation((args: { id: string; patch: Parameters<typeof api.patchLineItem>[1] }) =>
    api.patchLineItem(args.id, args.patch),
  );

export const useAddLineItem = (extractionId: string) =>
  useRecordMutation(() => api.addLineItem(extractionId));

export const useDeleteLineItem = () =>
  useRecordMutation((id: string) => api.deleteLineItem(id));

export const useMarkReviewed = (extractionId: string) =>
  useRecordMutation(() => api.markReviewed(extractionId));
