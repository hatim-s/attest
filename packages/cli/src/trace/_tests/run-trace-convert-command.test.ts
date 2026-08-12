import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { runTraceConvertCommand } from '../run-trace-convert-command.js';

const directories: string[] = [];
const traceId = '00112233445566778899aabbccddeeff';

/** Creates the smallest valid OTLP/HTTP JSON export accepted by the converter. */
const createExport = () => ({
  resourceSpans: [
    {
      scopeSpans: [
        {
          spans: [
            {
              traceId,
              spanId: '0011223344556677',
              parentSpanId: '',
              name: 'agent.run',
              startTimeUnixNano: '1786059000000000000',
              endTimeUnixNano: '1786059001000000000',
              status: { code: 1 },
            },
          ],
        },
      ],
    },
  ],
});

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map(async (directory) => rm(directory, { recursive: true })),
  );
});

describe('runTraceConvertCommand', () => {
  it('renders stdout JSON and guards file overwrites', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'attest-trace-convert-'));
    directories.push(directory);
    await writeFile(join(directory, 'trace.json'), JSON.stringify(createExport()));

    const stdout = await runTraceConvertCommand({
      inputPath: 'trace.json',
      workingDirectory: directory,
    });
    expect(JSON.parse(stdout.json)).toMatchObject({
      trace_id: traceId,
      spans: [{ kind: 'agent' }],
    });

    const written = await runTraceConvertCommand({
      inputPath: 'trace.json',
      outputPath: 'converted/trace.json',
      workingDirectory: directory,
    });
    await expect(readFile(written.outputPath ?? '', 'utf8')).resolves.toBe(written.json);
    await expect(
      runTraceConvertCommand({
        inputPath: 'trace.json',
        outputPath: 'converted/trace.json',
        workingDirectory: directory,
      }),
    ).rejects.toMatchObject({ code: 'output_exists' });
  });
});
