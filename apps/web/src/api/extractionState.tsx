import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

/**
 * Tracks the single in-flight extraction, application-wide.
 *
 * Extraction runs synchronously inside the upload request and takes tens of
 * seconds. Two things follow from that, and both need state that outlives the
 * page the user happens to be on:
 *
 *  - Only one extraction can be started at a time. Previously the lock lived
 *    inside the upload page's mutation, so navigating to Records mid-run made
 *    it invisible, and the Re-extract button on a record had no idea another
 *    extraction was already running.
 *  - The user needs to know something is still happening, and roughly how far
 *    along it is, from wherever they are in the app.
 */

export type ExtractionJob = {
  /** What is being processed, for display. */
  label: string;
  /** Where the request came from, so each surface can explain itself. */
  kind: 'upload' | 'sample' | 'reextract';
  startedAt: number;
};

type ExtractionState = {
  job: ExtractionJob | null;
  /** Seconds since the current job started. Ticks while a job is active. */
  elapsed: number;
  begin: (job: Omit<ExtractionJob, 'startedAt'>) => void;
  end: () => void;
};

const Ctx = createContext<ExtractionState | null>(null);

export const ExtractionProvider = ({ children }: { children: React.ReactNode }) => {
  const [job, setJob] = useState<ExtractionJob | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const active = useRef(false);

  const begin = useCallback((next: Omit<ExtractionJob, 'startedAt'>) => {
    // Guard rather than queue. A second extraction would sit behind the first
    // for the better part of a minute with no way to cancel it, and the UI
    // already prevents starting one; this is the backstop.
    if (active.current) return;
    active.current = true;
    setElapsed(0);
    setJob({ ...next, startedAt: Date.now() });
  }, []);

  const end = useCallback(() => {
    active.current = false;
    setJob(null);
    setElapsed(0);
  }, []);

  useEffect(() => {
    if (!job) return;
    const id = setInterval(() => {
      setElapsed(Math.floor((Date.now() - job.startedAt) / 1000));
    }, 500);
    return () => clearInterval(id);
  }, [job]);

  const value = useMemo(() => ({ job, elapsed, begin, end }), [job, elapsed, begin, end]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
};

export const useExtractionState = (): ExtractionState => {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useExtractionState must be used inside <ExtractionProvider>');
  return ctx;
};

/**
 * What the pipeline is doing, described honestly.
 *
 * The upload request is a single round trip, so there is no real progress to
 * report. These are the stages the request actually goes through with the
 * time each typically takes; the UI shows them as a description of the work
 * rather than as completed steps, and never claims a percentage it cannot
 * know.
 */
export const PIPELINE_STAGES = [
  { label: 'Uploading and storing the file', approxSeconds: 2 },
  { label: 'Reading the document', approxSeconds: 3 },
  { label: 'Extracting fields with the model', approxSeconds: 22 },
  { label: 'Validating and cross-checking totals', approxSeconds: 3 },
  { label: 'Saving the record', approxSeconds: 2 },
] as const;

/**
 * Best-guess current stage from elapsed time.
 *
 * Explicitly an estimate. It is used to say "this is roughly where it is",
 * never to render a progress percentage — the last stage stays selected for
 * as long as the request runs rather than the display appearing to stall at
 * 100%.
 */
export const estimateStage = (elapsedSeconds: number): number => {
  let cumulative = 0;
  for (const [i, stage] of PIPELINE_STAGES.entries()) {
    cumulative += stage.approxSeconds;
    if (elapsedSeconds < cumulative) return i;
  }
  return PIPELINE_STAGES.length - 1;
};
