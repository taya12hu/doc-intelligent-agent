import type { FullRecord } from '@dia/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client.js';
import { useExtractionState, type ExtractionJob } from './extractionState.js';

export const keys = {
  documents: ['documents'] as const,
  record: (id: string) => ['record', id] as const,
  samples: ['samples'] as const,
};

export const useDocuments = () =>
  useQuery({ queryKey: keys.documents, queryFn: api.listDocuments });

export const useRecord = (id: string) =>
  useQuery({ queryKey: keys.record(id), queryFn: () => api.getRecord(id) });

export const useSamples = () => useQuery({ queryKey: keys.samples, queryFn: api.listSamples });

/**
 * Every mutation returns the whole record, written straight into the cache
 * rather than invalidating and refetching. A correction changes flags,
 * confidence and status server-side, and writing the authoritative response
 * into the cache means those update the moment the server agrees — no refetch
 * flicker showing a stale flag beside a corrected value.
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

/**
 * A mutation that runs the extraction pipeline.
 *
 * Registers itself with the application-wide extraction state so that every
 * surface — the nav bar, the upload page, the Re-extract button on another
 * record — knows an extraction is running, and so a second one cannot be
 * started while it is.
 */
const useExtractionMutation = <TArgs>(
  fn: (args: TArgs) => Promise<FullRecord>,
  describe: (args: TArgs) => Omit<ExtractionJob, 'startedAt'>,
) => {
  const queryClient = useQueryClient();
  const { begin, end } = useExtractionState();

  return useMutation({
    mutationFn: fn,
    onMutate: (args) => {
      begin(describe(args));
    },
    onSuccess: (record) => {
      queryClient.setQueryData(keys.record(record.document.id), record);
      void queryClient.invalidateQueries({ queryKey: keys.documents });
    },
    // Clears on success and on failure alike. A stuck indicator would block
    // every future extraction behind a job that is no longer running.
    onSettled: () => {
      end();
    },
  });
};

export const useUpload = () =>
  useExtractionMutation(
    (file: File) => api.upload(file),
    (file) => ({ label: file.name, kind: 'upload' }),
  );

export const useRunSample = () =>
  useExtractionMutation(
    (sample: { key: string; label: string }) => api.runSample(sample.key),
    (sample) => ({ label: sample.label, kind: 'sample' }),
  );

export const useReextract = (documentId: string, filename: string) =>
  useExtractionMutation(
    () => api.reextract(documentId),
    () => ({ label: filename, kind: 'reextract' }),
  );

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

export const useDeleteLineItem = () => useRecordMutation((id: string) => api.deleteLineItem(id));

export const useMarkReviewed = (extractionId: string) =>
  useRecordMutation(() => api.markReviewed(extractionId));
