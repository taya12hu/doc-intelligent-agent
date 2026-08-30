import { flagMessage, flag } from '@dia/shared';
import type { RepairStep } from '@dia/shared';
import { describe, expect, it } from 'vitest';
import { describeTotalFailure } from './index.js';

/**
 * When extraction produces nothing at all, the record carries one flag
 * explaining why. It previously reused `unparseable`, whose headline is
 * "Found something here, but couldn't read it as a number" — wrong in every
 * total-failure case, and actively misleading on a quota failure where no
 * value was read at all.
 */

const step = (over: Partial<RepairStep> = {}): RepairStep => ({
  attempt: 1,
  stage: 'initial',
  model: 'flash',
  action: 'schema validation failed',
  ...over,
});

const transportStep = (error: string): RepairStep =>
  step({
    action: 'provider call failed after retries — this is a transport failure, not a bad extraction',
    error,
  });

describe('describeTotalFailure', () => {
  it('says the document was never read when the quota was exhausted', () => {
    const detail = describeTotalFailure([
      transportStep('Gemini daily free-tier quota exhausted for gemini-3.6-flash'),
    ]);
    expect(detail).toMatch(/quota is exhausted/);
    expect(detail).toMatch(/never read/);
    // The old wording claimed something was found and misparsed.
    expect(detail).not.toMatch(/number/);
  });

  it('distinguishes an unreachable API from an exhausted quota', () => {
    const detail = describeTotalFailure([transportStep('HTTP 503 service unavailable')]);
    expect(detail).toMatch(/could not be reached/);
    expect(detail).toMatch(/never read/);
  });

  it('says the model responded but produced nothing usable, when it did respond', () => {
    const detail = describeTotalFailure([step({ error: 'invoice.grandTotal: Required' })]);
    expect(detail).toMatch(/responded/);
    expect(detail).toMatch(/never produced a valid record/);
    expect(detail).not.toMatch(/never read/);
  });
});

describe('the rendered flag', () => {
  it('no longer claims a value was found and misread', () => {
    const detail = describeTotalFailure([transportStep('quota exhausted')]);
    const message = flagMessage(flag('_record', 'extraction_failed', detail));

    expect(message).toMatch(/^The extraction did not complete/);
    expect(message).not.toMatch(/Found something here/);
    expect(message).not.toMatch(/couldn't read it as a number/);
  });
});
