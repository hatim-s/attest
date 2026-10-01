import { describe, expect, it } from 'vitest';

import { AttestCliError, renderCliError, serializeCliError } from '../cli-error.js';

describe('CLI error contracts', () => {
  it('serializes expected errors identically for human and JSON boundaries', () => {
    const failure = serializeCliError(
      new AttestCliError('project_changed', 'The project changed.', {
        path: 'attest.project.json',
        hint: 'Retry with the current hash.',
        details: { current_hash: 'a'.repeat(64) },
      }),
    );

    expect(failure).toEqual({
      error: {
        code: 'project_changed',
        message: 'The project changed.',
        path: 'attest.project.json',
        hint: 'Retry with the current hash.',
        retryable: true,
        details: { current_hash: 'a'.repeat(64) },
      },
      exitCode: 3,
    });
    expect(renderCliError(failure.error)).toBe(
      'project_changed: The project changed.\n' +
        'Path: attest.project.json\n' +
        'Hint: Retry with the current hash.',
    );
  });

  it('normalizes unknown failures without exposing a stack', () => {
    const failure = serializeCliError(new Error('sensitive implementation detail'));

    expect(failure).toEqual({
      error: {
        code: 'internal_error',
        message: 'The command failed with an unknown internal error.',
        hint: 'Retry with the latest Attest version and report the stable error details.',
        retryable: false,
      },
      exitCode: 4,
    });
  });
});
