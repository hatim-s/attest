import { describe, expect, it } from 'vitest';

import {
  createCliFailureResult,
  createCliSuccessResult,
  serializeCliResult,
} from '../cli-protocol.js';

describe('CLI protocol serialization', () => {
  it('serializes success and failure as single-line JSON envelopes', () => {
    const success = createCliSuccessResult('project.show', { project_id: 'project-1' });

    const failure = createCliFailureResult('project.show', {
      code: 'project_changed',
      message: 'The project changed.',
      retryable: true,
    });

    const serializedSuccess = serializeCliResult(success);
    const serializedFailure = serializeCliResult(failure);

    expect(serializedSuccess).not.toContain('\n');
    expect(serializedFailure).not.toContain('\n');
    expect(JSON.parse(serializedSuccess)).toEqual({
      schema: 'attest.cli-result',
      ok: true,
      command: 'project.show',
      project_hash_before: null,
      project_hash_after: null,
      result: { project_id: 'project-1' },
      warnings: [],
    });
    expect(JSON.parse(serializedFailure)).toEqual({
      schema: 'attest.cli-result',
      ok: false,
      command: 'project.show',
      error: { code: 'project_changed', message: 'The project changed.', retryable: true },
    });
  });
});
