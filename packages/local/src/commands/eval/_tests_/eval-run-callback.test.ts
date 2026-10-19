import { createServer, type IncomingMessage } from 'node:http';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AGENT_COMPLETION_PROTOCOL,
  AGENT_RESOURCE_SCHEMA_ID,
  CLI_RESULT_SCHEMA_ID,
  COMMAND_REQUEST_SCHEMA_ID,
  METRIC_RESOURCE_SCHEMA_ID,
  TEST_RESOURCE_SCHEMA_ID,
  agentRequestSchema,
  evalFinalResultDataSchema,
  evalRunRequestSchema,
  type AgentResource,
  type EvalEvent,
  type EvalFinalResultData,
} from '@attest/contracts';
import { afterEach, expect, onTestFinished, test, vi } from 'vitest';
import { z } from 'zod';

import { loadProject } from '../../../project/project-loader/index.js';
import { applyProjectMutation } from '../../../project/transaction/transactional-writer.js';
import { runConfiguration } from '../../../run/run-configuration.js';
import { openStore } from '../../../store/index.js';
import { runAgentImportCommand } from '../../agent/import.js';
import { runAgentTestCommand } from '../../agent/test.js';
import { candidateFromLoadedProject } from '../../project/load-command-project.js';
import { runProjectInitCommand } from '../../project/project-init-command.js';

const ANSWER = 'export const answer = 42;\n';

const NOTES = '# Notes\n';

/** Passes only when both artifacts are files under artifact_dir with the expected text. */
const SCORE_METRIC = [
  "import { readFileSync } from 'node:fs';",
  "import { join } from 'node:path';",
  '',
  "let source = '';",
  'for await (const chunk of process.stdin) source += chunk;',
  'const request = JSON.parse(source);',
  "const answer = readFileSync(join(request.artifact_dir, 'src/answer.ts'), 'utf8');",
  "const notes = readFileSync(join(request.artifact_dir, 'notes.md'), 'utf8');",
  `const pass = answer === ${JSON.stringify(ANSWER)} && notes === ${JSON.stringify(NOTES)};`,
  'process.stdout.write(JSON.stringify({ score: pass ? 1 : 0, pass }));',
].join('\n');

const directories: string[] = [];

const temporaryDirectory = async (prefix: string): Promise<string> => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  directories.push(directory);

  return directory;
};

const readBody = async (incoming: IncomingMessage): Promise<string> => {
  let body = '';

  for await (const chunk of incoming) body += String(chunk);

  return body;
};

/**
 * A mock async agent on loopback. The trigger answers 202, then posts a completion with one inline
 * and one reference artifact; the reference is served from `/artifacts/<id>`.
 */
const startMockAgent = async (): Promise<string> => {
  const server = createServer((incoming, response) => {
    void (async () => {
      if (incoming.url === '/artifacts/notes-1') {
        response.writeHead(200, { 'content-type': 'text/markdown' }).end(NOTES);

        return;
      }

      const request = agentRequestSchema.parse(JSON.parse(await readBody(incoming)));
      response.writeHead(202).end();

      if (request.callback === undefined) return;
      await fetch(request.callback.url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${request.callback.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          protocol: AGENT_COMPLETION_PROTOCOL,
          run_id: request.run_id,
          case_id: request.case_id,
          output: 'Wrote answer.ts',
          artifacts: [
            {
              kind: 'inline',
              path: 'src/answer.ts',
              media_type: 'text/typescript',
              encoding: 'utf8',
              content: ANSWER,
            },
            { kind: 'reference', path: 'notes.md', id: 'notes-1' },
          ],
        }),
      });
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = z.object({ port: z.number() }).parse(server.address());
  onTestFinished(() => {
    server.closeAllConnections();
    server.close();
  });

  return `http://127.0.0.1:${port}`;
};

const terminalFailure = (code: 'cancelled' | 'run_failed', message: string): EvalFinalResultData =>
  evalFinalResultDataSchema.parse({
    exit_code: code === 'cancelled' ? 130 : 4,
    result: {
      schema: CLI_RESULT_SCHEMA_ID,
      ok: false,
      command: 'eval.run',
      error: { code, message, retryable: true },
    },
  });

/** Creates a project, imports the callback agent from a JSON file, and adds the metric and test. */
const createCallbackProject = async (origin: string): Promise<string> => {
  const root = await temporaryDirectory('attest-eval-callback-');

  await runProjectInitCommand({
    directory: '.',
    interactive: false,
    name: 'Callback eval',
    readStdin: () => Promise.resolve(''),
    registryPath: join(await temporaryDirectory('attest-registry-'), 'projects.json'),
    workingDirectory: root,
  });

  const agent: AgentResource = {
    schema: AGENT_RESOURCE_SCHEMA_ID,
    id: 'source',
    name: 'Async coder',
    transport: {
      kind: 'callback',
      lifecycle: 'external',
      trigger: { url: `${origin}/trigger`, method: 'POST' },
      artifact_fetch: { url: `${origin}/artifacts/{{artifact_id}}`, method: 'GET' },
    },
    timeouts: { attempt_ms: 10_000 },
  };

  await writeFile(join(root, 'agent.json'), JSON.stringify(agent));
  await writeFile(join(root, 'score.mjs'), SCORE_METRIC);

  await runAgentImportCommand({
    interactive: false,
    project: root,
    readStdin: () => Promise.reject(new Error('stdin must not be read')),
    request: {
      schema: COMMAND_REQUEST_SCHEMA_ID,
      command: 'agent.import',
      source: 'agent.json',
      source_type: 'json',
      as: 'coder',
    },
    workingDirectory: root,
  });

  const candidate = candidateFromLoadedProject(await loadProject({ project: root }));

  candidate.metrics.push({
    schema: METRIC_RESOURCE_SCHEMA_ID,
    id: 'files',
    name: 'files',
    definition: { kind: 'exec', argv: [process.execPath, 'score.mjs'] },
  });
  candidate.tests.push({
    schema: TEST_RESOURCE_SCHEMA_ID,
    id: 'smoke',
    name: 'smoke',
    agent_id: 'coder',
    cases: [{ id: 'write-file', input: 'write answer.ts' }],
    datasets: [],
    metrics: [{ metric_id: 'files' }],
  });
  await applyProjectMutation({ candidate, projectRoot: root });

  return root;
};

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

test('runs a callback agent, persists inline artifacts only, and scores them as files', async () => {
  vi.stubEnv('ATTEST_HOME', await temporaryDirectory('attest-home-'));
  const root = await createCallbackProject(await startMockAgent());

  const events: EvalEvent[] = [];

  const stream = await runConfiguration(
    evalRunRequestSchema.parse({
      schema: COMMAND_REQUEST_SCHEMA_ID,
      command: 'eval.run',
      output: 'json',
      test_ids: ['smoke'],
    }),
    {
      argv: ['eval', 'run'],
      signal: new AbortController().signal,
      terminalFailure,
      workingDirectory: root,
    },
  );

  for await (const event of stream) events.push(event);
  const started = events[0];

  if (started?.event !== 'run_started') throw new Error('Expected run_started first.');

  const store = await openStore(join(root, '.attest', 'runs.db'));

  try {
    const { cases } = await store.runs.getRunWithCases(started.data.run_id);

    expect(cases).toHaveLength(1);
    expect(cases[0]).toMatchObject({
      outcome: 'completed',
      response: {
        output: 'Wrote answer.ts',
        artifacts: [
          { kind: 'inline', path: 'src/answer.ts', encoding: 'utf8', content: ANSWER },
          {
            kind: 'inline',
            path: 'notes.md',
            media_type: 'text/markdown',
            encoding: 'utf8',
            content: NOTES,
          },
        ],
      },
      metrics: [{ metricName: 'files', status: 'evaluated', pass: true }],
    });
  } finally {
    await store.close();
  }

  // `attest agent test` reuses the same session runtime for a callback agent.
  const probe = await runAgentTestCommand({
    project: root,
    request: {
      schema: COMMAND_REQUEST_SCHEMA_ID,
      command: 'agent.test',
      agent_id: 'coder',
      input: 'probe',
    },
    workingDirectory: root,
  });

  expect(probe).toMatchObject({
    result: {
      agent_id: 'coder',
      transport: 'callback',
      attempts: [{ status: 'ok', diagnostics: { httpStatus: 202 } }],
      response: { output: 'Wrote answer.ts' },
    },
  });
}, 30_000);
