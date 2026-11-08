import { AttestError, tryClassify } from '@attest/contracts';
import * as Effect from 'effect/Effect';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { convertOtlpJson, selectConvertedTrace } from '@attest/core';

import { errnoCode } from '../internal/errno-code.js';
import { LocalError } from '../errors/index.js';

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

/** Reads OTLP JSON, selects one trace, and optionally writes without clobbering. */
const runTraceConvertCommand = Effect.fn('runTraceConvertCommand')(function* (
  options: RunTraceConvertCommandOptions,
) {
  const inputPath = resolve(options.workingDirectory, options.inputPath);

  const readError = (cause: unknown) =>
    new LocalError('trace_convert_failed', `Could not read OTLP JSON from ${inputPath}.`, {
      cause,
    });

  const text = yield* Effect.tryPromise({
    try: () => readFile(inputPath, 'utf8'),
    catch: readError,
  });

  // Converter AttestErrors keep their code and malformed JSON is a read failure; any other
  // throw is a defect.
  const trace = yield* tryClassify(
    () => selectConvertedTrace(convertOtlpJson(JSON.parse(text)), options.traceId),
    (cause) => {
      if (cause instanceof AttestError) return cause;

      return cause instanceof SyntaxError ? readError(cause) : undefined;
    },
  );

  const json = `${JSON.stringify(trace, null, 2)}\n`;

  if (options.outputPath === undefined)
    return { json, spanCount: trace.spans.length, traceId: trace.trace_id };
  const outputPath = resolve(options.workingDirectory, options.outputPath);

  const outputError = (cause: unknown) =>
    errnoCode(cause) === 'EEXIST'
      ? new LocalError(
          'output_exists',
          `Trace output already exists at ${outputPath}; pass --force to replace it.`,
          { cause },
        )
      : new LocalError('output_write_failed', `Could not write converted trace to ${outputPath}.`, {
          cause,
        });

  yield* Effect.tryPromise({
    try: () => mkdir(dirname(outputPath), { recursive: true }),
    catch: outputError,
  });
  yield* Effect.tryPromise({
    try: () =>
      writeFile(outputPath, json, { encoding: 'utf8', flag: options.force === true ? 'w' : 'wx' }),
    catch: outputError,
  });

  return { json, outputPath, spanCount: trace.spans.length, traceId: trace.trace_id };
});

export {
  runTraceConvertCommand,
  type RunTraceConvertCommandOptions,
  type RunTraceConvertCommandResult,
};
