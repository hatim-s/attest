import { describe, expect, it } from 'vitest';
import { caseStanding, passedCount } from '../case-standing.js';

const complete = { state: 'complete' } as const;

const running = { state: 'running' } as const;

const incomplete = { state: 'incomplete' } as const;

describe('Failing', () => {
  it('reads the newest complete run', () => {
    expect(caseStanding([complete, complete], ['fail', 'pass']).failing).toBe(true);
    expect(caseStanding([complete, complete], ['error', 'pass']).failing).toBe(true);
    expect(caseStanding([complete, complete], ['pass', 'fail']).failing).toBe(false);
  });

  it('skips newer runs that did not complete', () => {
    expect(caseStanding([running, incomplete, complete], ['pass', 'pass', 'fail']).failing).toBe(
      true,
    );
    expect(caseStanding([incomplete, complete], ['fail', 'pass']).failing).toBe(false);
  });

  it('is never failing without a complete run', () => {
    expect(caseStanding([running, incomplete], ['fail', 'error']).failing).toBe(false);
    expect(caseStanding([], []).failing).toBe(false);
  });

  it('does not treat a missing row or a skipped result as a failure', () => {
    expect(caseStanding([complete, complete], [null, 'fail']).failing).toBe(false);
    expect(caseStanding([complete, complete], ['skipped', 'fail']).failing).toBe(false);
  });
});

describe('Flaky', () => {
  it('needs a pass and a failure or error in the window', () => {
    expect(caseStanding([complete, incomplete], ['pass', 'fail']).flaky).toBe(true);
    expect(caseStanding([complete, complete], ['error', 'pass']).flaky).toBe(true);
  });

  it('ignores missing rows and skipped results', () => {
    expect(caseStanding([complete, complete, complete], ['pass', null, 'skipped']).flaky).toBe(
      false,
    );
    expect(caseStanding([complete, complete, complete], ['fail', null, 'skipped']).flaky).toBe(
      false,
    );
    expect(caseStanding([complete, complete], ['fail', 'error']).flaky).toBe(false);
  });
});

describe('passed count', () => {
  it('counts recorded results only, skipped included', () => {
    expect(passedCount(['pass', null, 'skipped', 'fail', 'pass', null])).toEqual({
      passed: 2,
      recorded: 4,
    });
  });

  it('is zero of zero when the case has no row in any run', () => {
    expect(passedCount([null, null])).toEqual({ passed: 0, recorded: 0 });
  });
});
