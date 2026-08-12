import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { convertOtlpJson, selectConvertedTrace } from '@attest/core';

import { AttestCliError } from '../errors/index.js';

type RunTraceConvertCommandOptions = {
  force?: boolean;
  inputPath: string;
  outputPath?: string;
  traceId?: string;
  workingDirectory: string;
};

type RunTraceConvertCommandResult = {
  json: string;
  outputPath?: string;
  spanCount: number;
  traceId: string;
};

const isNodeError = (error: unknown): error is NodeJS.ErrnoException => error instanceof Error;

/** Reads OTLP JSON, selects one trace, and optionally writes without clobbering. */
const runTraceConvertCommand = async (
  options: RunTraceConvertCommandOptions,
): Promise<RunTraceConvertCommandResult> => {
  const inputPath = resolve(options.workingDirectory, options.inputPath);
  let candidate: unknown;
  try {
    candidate = JSON.parse(await readFile(inputPath, 'utf8')) as unknown;
  } catch (error: unknown) {
    throw new AttestCliError(
      'trace_convert_failed',
      `Could not read OTLP JSON from ${inputPath}.`,
      { cause: error },
    );
  }

  const trace = selectConvertedTrace(convertOtlpJson(candidate), { traceId: options.traceId });
  const json = `${JSON.stringify(trace, null, 2)}\n`;
  if (options.outputPath === undefined) {
    return { json, spanCount: trace.spans.length, traceId: trace.trace_id };
  }

  const outputPath = resolve(options.workingDirectory, options.outputPath);
  try {
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, json, {
      encoding: 'utf8',
      flag: options.force === true ? 'w' : 'wx',
    });
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === 'EEXIST') {
      throw new AttestCliError(
        'output_exists',
        `Trace output already exists at ${outputPath}; pass --force to replace it.`,
        { cause: error },
      );
    }
    throw new AttestCliError(
      'output_write_failed',
      `Could not write converted trace to ${outputPath}.`,
      { cause: error },
    );
  }

  return { json, outputPath, spanCount: trace.spans.length, traceId: trace.trace_id };
};

export {
  runTraceConvertCommand,
  type RunTraceConvertCommandOptions,
  type RunTraceConvertCommandResult,
};
