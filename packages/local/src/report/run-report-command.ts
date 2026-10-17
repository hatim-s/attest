import { randomUUID } from 'node:crypto';
import { link, open, rename, unlink } from 'node:fs/promises';

import { summarizeCaseRecord } from '@attest/core';
import { dashboardHtml } from '@attest/web/embedded';

import { errnoCode } from '../internal/errno-code.js';
import { LocalError } from '../errors/index.js';
import { prepareEvalProjectFile } from '../commands/eval/eval-project-path.js';
import { withReadonlyRunStoreFile } from '../commands/run-store/readonly-run-store.js';
import { withRunNotFound } from '../commands/run-store/run-not-found.js';
import { createDashboardHtml } from '@attest/api';
import type { ReportSnapshot } from '@attest/api/contract';
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
const runReportCommand = async (
  options: RunReportCommandOptions,
): Promise<RunReportCommandResult> => {
  const configuredStorePath = options.storePath ?? '.attest/runs.db';

  const storePath = await prepareEvalProjectFile(options.workingDirectory, configuredStorePath, {
    allowAbsolute: true,
    errorCode: 'project_read_failed',
    message: 'The report run store is not a safe project file.',
  });

  const runNotFound = (cause?: unknown): LocalError =>
    new LocalError('resource_not_found', `Run ${options.runId} was not found.`, {
      path: options.runId,
      cause,
    });

  const runWithCases = await withRunNotFound(
    () =>
      withReadonlyRunStoreFile(storePath, (store) =>
        readBoundedRunDetails(store, { runId: options.runId, limit: MAX_REPORT_CASES }),
      ),
    runNotFound,
  );

  if (runWithCases === undefined) throw runNotFound();

  const cases = runWithCases.cases;
  const truncated = runWithCases.totalCaseCount > cases.length;

  const snapshot: ReportSnapshot = {
    generatedAt: new Date().toISOString(),
    run: runWithCases.run,
    cases: cases.map((record) => ({ record, summary: summarizeCaseRecord(record) })),
    truncated: truncated,
  };

  const outputPath = await prepareEvalProjectFile(
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

  try {
    handle = await open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(
      createDashboardHtml(dashboardHtml, { kind: 'snapshot', snapshot }),
      'utf8',
    );
    await handle.sync();
    await handle.close();
    handle = undefined;

    if (options.force === true) await rename(temporaryPath, outputPath);
    else {
      await link(temporaryPath, outputPath);
      await unlink(temporaryPath);
    }
  } catch (error: unknown) {
    await handle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);

    if (errnoCode(error) === 'EEXIST') {
      throw new LocalError(
        'output_exists',
        `Report already exists at ${outputPath}; pass --force to replace it.`,
        { cause: error },
      );
    }

    throw new LocalError('output_write_failed', `Could not write report to ${outputPath}.`, {
      cause: error,
    });
  }

  return {
    caseCount: cases.length,
    outputPath,
    totalCaseCount: runWithCases.totalCaseCount,
    truncated: truncated,
  };
};

export { runReportCommand, type RunReportCommandOptions, type RunReportCommandResult };
