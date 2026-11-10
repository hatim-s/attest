import { describe, expect, it, onTestFinished } from 'vitest';
import { EvalResolutionError, StoreError } from '@attest/core';
import { LocalError } from '@attest/local';
import { CommanderError } from 'commander';
import * as Cause from 'effect/Cause';
import { createServer, type AddressInfo } from 'node:net';

import { runCommand, temporaryDirectory } from '../../_tests_/support/cli-test-support.js';
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

it('retains the safe public store code after native error migration', () => {
  const failure = serializeCliError(new StoreError('READ_FAILED', 'sensitive database detail'));
  expect(failure).toEqual({
    error: {
      code: 'internal_error',
      message: 'The command failed with an unclassified Attest error.',
      hint: 'Retry with the latest Attest version and report the stable error details.',
      retryable: false,
      details: { cause_code: 'READ_FAILED' },
    },
    exitCode: 4,
  });
});

it.each([
  [
    'a local error by its catalog code',
    new LocalError('project_locked', 'The project is locked.', {
      path: '.attest/project.lock',
      hint: 'Wait for the other process.',
      details: { lock_state: 'held' },
    }),
    {
      error: {
        code: 'project_locked',
        message: 'The project is locked.',
        path: '.attest/project.lock',
        hint: 'Wait for the other process.',
        retryable: true,
        details: { lock_state: 'held' },
      },
      exitCode: 3,
    },
  ],
  [
    'a Commander usage error as cli_usage',
    new CommanderError(1, 'commander.unknownOption', "error: unknown option '--nope'"),
    {
      error: {
        code: 'cli_usage',
        message: "error: unknown option '--nope'",
        hint: 'Run `attest help --output json` and use a registered command path.',
        retryable: false,
      },
      exitCode: 2,
    },
  ],
  [
    'a coded error outside the catalog by its cause code',
    new EvalResolutionError('resource_not_found', 'sensitive resolution detail'),
    {
      error: {
        code: 'internal_error',
        message: 'The command failed with an unclassified Attest error.',
        hint: 'Retry with the latest Attest version and report the stable error details.',
        retryable: false,
        details: { cause_code: 'resource_not_found' },
      },
      exitCode: 4,
    },
  ],
  [
    'a foreign failure as an unknown internal error',
    new Cause.UnknownError(new Error('sensitive transport detail')),
    {
      error: {
        code: 'internal_error',
        message: 'The command failed with an unknown internal error.',
        hint: 'Retry with the latest Attest version and report the stable error details.',
        retryable: false,
      },
      exitCode: 4,
    },
  ],
] as const)('renders %s', (_name, failure, expected) => {
  expect(serializeCliError(failure)).toEqual(expected);
});

// run-cli renders a command's typed failure by type, so a local infrastructure failure reaches
// its own switch arm instead of being re-wrapped as Cause.UnknownError.
it('renders a web server bind failure from the typed command Cause', async () => {
  const root = await temporaryDirectory('attest-cli-typed-failure-');
  const blocker = createServer();
  await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  onTestFinished(() => new Promise<void>((resolve) => blocker.close(() => resolve())));
  // SAFETY: A completed TCP listen on a loopback host returns AddressInfo, never a pipe path.
  const { port } = blocker.address() as AddressInfo;

  const run = await runCommand(root, ['web', '--port', String(port), '--no-open']);

  expect(run.exitCode).toBe(4);
  expect(run.errors).toEqual([
    'internal_error: The command failed with an unknown internal error.\n' +
      'Hint: Retry with the latest Attest version and report the stable error details.',
  ]);
});
