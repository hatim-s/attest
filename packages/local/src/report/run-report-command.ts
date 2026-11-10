import * as Effect from 'effect/Effect';
import { randomUUID } from 'node:crypto';
import { link, open, rename, unlink } from 'node:fs/promises';

import { createDashboardHtml } from '@attest/api';
import type { ReportSnapshot } from '@attest/api/contract';
import { summarizeCaseRecord } from '@attest/core';
import { dashboardHtml } from '@attest/web/embedded';

import { PROJECT_STORE_PATH } from '../project/project-store-path.js';
import { withReadCleanup } from '../store/internal/read-cleanup.js';
import { errnoCode } from '../internal/errno-code.js';
import { LocalError } from '../errors/index.js';
import { prepareEvalProjectFile } from '../commands/eval/eval-project-path.js';
import { withReadonlyRunStoreFile } from '../commands/run-store/readonly-run-store.js';
import { withRunNotFound } from '../commands/run-store/run-not-found.js';
import { describeStoreProject } from '../project/describe-store-project.js';
import { readBoundedRunDetails } from '../store/bounded-run-details.js';

// Bound embedded HTML size and the per-case detail queries needed to generate it.
const MAX_REPORT_CASES = 10_000;

type RunReportCommandOptions = {
  force?: boolean;
  outputPath?: string;
  runId: string;
  storePath?: string;
  workingDirectory: string;
};

type RunReportCommandResult = {
  caseCount: number;
  outputPath: string;
  totalCaseCount: number;
  truncated: boolean;
};

/** Materializes one bounded, self-contained run report without overwriting by default. */
const runReportCommand = Effect.fn('runReportCommand')(function* (
  options: RunReportCommandOptions,
) {
  const configuredStorePath = options.storePath ?? PROJECT_STORE_PATH;

  const storePath = yield* prepareEvalProjectFile(options.workingDirectory, configuredStorePath, {
    allowAbsolute: true,
    errorCode: 'project_read_failed',
    message: 'The report run store is not a safe project file.',
  });

  const runNotFound = (cause?: unknown): LocalError =>
    new LocalError('resource_not_found', `Run ${options.runId} was not found.`, {
      path: options.runId,
      cause,
    });

  const runWithCases = yield* withRunNotFound(
    () =>
      withReadonlyRunStoreFile(storePath, (store) =>
        readBoundedRunDetails(store, { runId: options.runId, limit: MAX_REPORT_CASES }),
      ),
    runNotFound,
  );

  if (runWithCases === undefined) return yield* Effect.fail(runNotFound());

  const cases = runWithCases.cases;
  const truncated = runWithCases.totalCaseCount > cases.length;

  // Reports are shared beyond this machine, so the local root path stays out of them.
  const { key, name, projectId } = yield* describeStoreProject(storePath);

  const snapshot: ReportSnapshot = {
    generatedAt: new Date().toISOString(),
    project: { key, name, projectId },
    run: runWithCases.run,
    cases: cases.map((record) => ({ record, summary: summarizeCaseRecord(record) })),
    truncated: truncated,
  };

  const outputPath = yield* prepareEvalProjectFile(
    options.workingDirectory,
    options.outputPath ?? `attest-report-${options.runId}.html`,
    {
      allowAbsolute: true,
      createDirectories: true,
      errorCode: 'output_write_failed',
      message: 'The report output path is not a safe project file.',
    },
  );

  const temporaryPath = `${outputPath}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;

  const outputError = (cause: unknown) =>
    errnoCode(cause) === 'EEXIST'
      ? new LocalError(
          'output_exists',
          `Report already exists at ${outputPath}; pass --force to replace it.`,
          { cause },
        )
      : new LocalError('output_write_failed', `Could not write report to ${outputPath}.`, {
          cause,
        });

  const call = <A>(operation: () => Promise<A>) =>
    Effect.tryPromise({ try: operation, catch: outputError });

  yield* withReadCleanup(
    Effect.gen(function* () {
      const opened = yield* call(() => open(temporaryPath, 'wx', 0o600));
      handle = opened;
      yield* call(() =>
        opened.writeFile(
          createDashboardHtml(dashboardHtml, { kind: 'snapshot', snapshot }),
          'utf8',
        ),
      );
      yield* call(() => opened.sync());
      yield* call(() => opened.close());
      handle = undefined;

      if (options.force === true) yield* call(() => rename(temporaryPath, outputPath));
      else yield* call(() => link(temporaryPath, outputPath));
    }),
    () => [
      ...(handle === undefined ? [] : [call(() => handle!.close())]),
      call(() => unlink(temporaryPath)).pipe(
        Effect.catch((error) =>
          errnoCode(error.cause) === 'ENOENT' ? Effect.void : Effect.fail(error),
        ),
      ),
    ],
  );

  return {
    caseCount: cases.length,
    outputPath,
    totalCaseCount: runWithCases.totalCaseCount,
    truncated: truncated,
  };
});

export { runReportCommand, type RunReportCommandOptions, type RunReportCommandResult };
