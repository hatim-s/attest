import { randomUUID } from 'node:crypto';
import { link, open, rename, unlink } from 'node:fs/promises';

import { StoreError, summarizeCaseRecord, type RunStore } from '@attest/core';
import { dashboardHtml } from '@attest/web/embedded';

import { LocalError } from '../errors/index.js';
import { prepareEvalProjectFile } from '../commands/eval/eval-project-path.js';
import { withReadonlyRunStoreFile } from '../commands/run-store/readonly-run-store.js';
import { createReportHtml } from './create-report-html.js';

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

/** Applies the report evidence ceiling without mutating the store result. */
const selectReportCases = <T>(cases: T[]): { cases: T[]; truncated: boolean } => ({
  cases: cases.slice(0, MAX_REPORT_CASES),
  truncated: cases.length > MAX_REPORT_CASES,
});

const isNodeError = (error: unknown): error is NodeJS.ErrnoException => error instanceof Error;

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
  let runWithCases: Awaited<ReturnType<RunStore['getRunWithCases']>> | undefined;
  try {
    runWithCases = await withReadonlyRunStoreFile(storePath, (store) =>
      store.getRunWithCases(options.runId),
    );
  } catch (error: unknown) {
    if (error instanceof StoreError && error.code === 'RUN_NOT_FOUND') {
      throw new LocalError('resource_not_found', `Run ${options.runId} was not found.`, {
        path: options.runId,
        cause: error,
      });
    }
    throw error;
  }
  if (runWithCases === undefined) {
    throw new LocalError('resource_not_found', `Run ${options.runId} was not found.`, {
      path: options.runId,
    });
  }

  const selection = selectReportCases(runWithCases.cases);
  const reportData = {
    schema: 'attest.report',
    generatedAt: new Date().toISOString(),
    run: runWithCases.run,
    cases: selection.cases.map((record) => ({ record, summary: summarizeCaseRecord(record) })),
    truncated: selection.truncated,
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
    await handle.writeFile(createReportHtml(dashboardHtml, reportData), 'utf8');
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
    if (isNodeError(error) && error.code === 'EEXIST') {
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
    caseCount: selection.cases.length,
    outputPath,
    totalCaseCount: runWithCases.cases.length,
    truncated: selection.truncated,
  };
};

export {
  MAX_REPORT_CASES,
  runReportCommand,
  selectReportCases,
  type RunReportCommandOptions,
  type RunReportCommandResult,
};
