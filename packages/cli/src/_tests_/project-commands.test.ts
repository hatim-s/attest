import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { cliHelpSchema } from '@attest/contracts';
import { applyProjectMutation, loadProject } from '@attest/local/project';
import { openStore } from '@attest/local/store';
import { describe, expect, it } from 'vitest';

import {
  createFixtureProject,
  runCommand,
  runJson,
  temporaryDirectory,
} from './support/cli-test-support.js';
import { projectResources } from './support/project-fixture.js';

describe('project commands', () => {
  it('initializes, shows, validates, and lists an empty project', async () => {
    const parent = await temporaryDirectory('attest-project-');
    const init = await runJson(parent, ['project', 'init', 'demo', '--name', 'Demo']);

    expect(init.exitCode).toBe(0);
    expect(init.document).toMatchObject({
      ok: true,
      command: 'project.init',
      project_hash_before: null,
      result: { committed: true, dry_run: false, project: { name: 'Demo' } },
    });
    if (!init.document.ok) throw new Error('Expected project.init success.');
    const projectRoot = join(parent, 'demo');
    const loaded = await loadProject({ project: projectRoot });
    expect(init.document.project_hash_after).toBe(loaded.projectHash);

    for (const argv of [
      ['project', 'show'],
      ['project', 'validate'],
      ['list', 'agents'],
    ]) {
      expect((await runJson(projectRoot, argv)).exitCode).toBe(0);
    }
  });

  it('keeps TTY guidance and non-TTY defaults on the same normalized request path', async () => {
    const parent = await temporaryDirectory('attest-project-');
    const questions: string[] = [];
    await runCommand(parent, ['project', 'init', 'guided'], {
      interaction: {
        inputIsTTY: true,
        outputIsTTY: true,
        prompt: (question) => {
          questions.push(question);
          return Promise.resolve('Guided Project');
        },
      },
    });
    expect(questions).toEqual(['Project name [guided]: ']);
    await expect(loadProject({ project: join(parent, 'guided') })).resolves.toMatchObject({
      project: { name: 'Guided Project' },
    });

    await runCommand(parent, ['project', 'init', 'automatic']);
    await expect(loadProject({ project: join(parent, 'automatic') })).resolves.toMatchObject({
      project: { name: 'automatic' },
    });
  });

  it('accepts a complete project.init request from stdin and preserves the init alias', async () => {
    const parent = await temporaryDirectory('attest-project-');
    const request = JSON.stringify({
      schema: 'attest.command-request',
      command: 'project.init',
      directory: 'stdin-project',
      name: 'Stdin Project',
    });
    const stdin = await runJson(parent, ['project', 'init', '--from-json', '-'], {
      stdin: request,
    });
    expect(stdin.exitCode).toBe(0);
    expect(stdin.document).toMatchObject({
      ok: true,
      command: 'project.init',
      result: { project: { name: 'Stdin Project' } },
    });

    const alias = await runJson(parent, ['init', 'alias-project', '--name', 'Alias']);
    expect(alias.exitCode).toBe(0);
    expect(alias.document).toMatchObject({ ok: true, command: 'project.init' });

    const help = await runJson(parent, ['help', 'init']);
    if (!help.document.ok) throw new Error('Expected init help.');
    expect(cliHelpSchema.parse(help.document.result).command.alias_for).toBe('project.init');
  });

  it('reports an expected-project-hash conflict without writing', async () => {
    const parent = await temporaryDirectory('attest-project-');
    const conflict = await runJson(parent, [
      'project',
      'init',
      'conflict',
      '--name',
      'Conflict',
      '--if-project-hash',
      'a'.repeat(64),
    ]);

    expect(conflict.exitCode).toBe(3);
    expect(conflict.document).toMatchObject({
      ok: false,
      command: 'project.init',
      error: { code: 'project_changed', details: { current_hash: null } },
    });
    await expect(access(join(parent, 'conflict'))).rejects.toBeDefined();

    const missing = await runJson(parent, ['project', 'validate', '--project', 'missing']);
    expect(missing.exitCode).toBe(1);
    expect(missing.document).toMatchObject({
      ok: false,
      command: 'project.validate',
      error: { code: 'project_read_failed' },
    });
  });

  it('rejects every overlapping init request source before reading stdin or writing', async () => {
    const parent = await temporaryDirectory('attest-project-');
    const requestPath = join(parent, 'request.json');
    await writeFile(
      requestPath,
      JSON.stringify({
        schema: 'attest.command-request',
        command: 'project.init',
        directory: 'request-project',
        name: 'Request Project',
      }),
    );
    const rejectStdin = {
      readStdin: () => Promise.reject(new Error('stdin must not be consumed on conflict')),
    };

    const cases = [
      {
        argv: ['project', 'init', 'positional', '--project', 'flag-project'],
        expected: ['directory', 'project'],
      },
      {
        argv: ['project', 'init', 'positional', '--from-json', requestPath],
        expected: ['directory'],
      },
      {
        argv: ['project', 'init', '--from-json', '-', '--name', 'Flag Name', '--dry-run'],
        expected: ['dry-run', 'name'],
      },
    ];
    for (const { argv, expected } of cases) {
      const response = await runJson(parent, argv, { interaction: rejectStdin });
      expect(response.exitCode).toBe(2);
      expect(response.document).toMatchObject({
        error: { code: 'cli_usage', details: { conflicting_fields: expected } },
      });
    }
    expect((await readdir(parent)).sort()).toEqual(['request.json']);

    const help = await runJson(parent, ['help', 'project', 'init']);
    if (!help.document.ok) throw new Error('Expected project init help.');
    const { options } = cliHelpSchema.parse(help.document.result).command;
    expect(options.find(({ name }) => name === 'from-json')?.conflicts).toEqual([
      'directory',
      'project',
      'name',
      'dry-run',
      'yes',
      'if-project-hash',
    ]);
  });

  it('lists and shows canonical resources, then returns aggregate validation diagnostics', async () => {
    const root = await createFixtureProject();

    const list = await runJson(root, ['list', 'agents']);
    expect(list.document).toMatchObject({
      result: { items: [{ id: 'support', transport: 'native_cli' }] },
    });
    const show = await runJson(root, ['show', 'agent', 'support']);
    expect(show.document).toMatchObject({
      result: { resource: { id: 'support', name: 'Support' } },
    });
    const missing = await runJson(root, ['show', 'agent', 'missing']);
    expect(missing.exitCode).toBe(1);
    expect(missing.document).toMatchObject({ error: { code: 'resource_not_found' } });

    for (const path of ['attest/agents/support.json', 'attest/metrics/correct.json']) {
      const resource = JSON.parse(await readFile(join(root, path), 'utf8')) as object;
      await writeFile(
        join(root, path),
        `${JSON.stringify({ ...resource, secret: 'must-not-render' })}\n`,
      );
    }
    const validation = await runJson(root, ['project', 'validate']);
    expect(validation.exitCode).toBe(1);
    expect(validation.output.join('')).not.toContain('must-not-render');
    if (validation.document.ok) throw new Error('Expected project validation failure.');
    expect(validation.document.error.code).toBe('project_invalid');
    // Contracts has no schema for diagnostic details, so this one read is typed by hand.
    const { diagnostics } = validation.document.error.details as {
      diagnostics: { source: string }[];
    };
    const sources = diagnostics.map(({ source }) => source);
    expect(sources).toEqual([...sources].sort());
    expect(sources).toEqual(
      expect.arrayContaining(['attest/agents/support.json', 'attest/metrics/correct.json']),
    );
  });

  it('redacts authored transport credentials from human and JSON resource output', async () => {
    const root = await createFixtureProject();
    const candidate = projectResources(await loadProject({ project: root }));
    candidate.agents[0]!.transport = {
      kind: 'http',
      lifecycle: 'external',
      response_mode: 'mapped',
      request: {
        url: 'https://user:authored-url-password@example.test/invoke?token=authored-url-token',
        method: 'POST',
        headers: { Authorization: 'Bearer authored-agent-secret' },
        query: { api_key: 'authored-query-secret' },
      },
      extraction: { result_pointer: '/result' },
    };
    candidate.agents.push({
      ...structuredClone(candidate.agents[0]!),
      id: 'worker',
      name: 'Worker',
      transport: {
        kind: 'native_cli',
        lifecycle: 'per_case',
        argv: ['node', 'authored-argv-secret'],
      },
      redaction: { argv_positions: [1] },
    });
    await applyProjectMutation({ candidate, projectRoot: root });

    const human = await runCommand(root, ['show', 'agent', 'support']);
    const json = await runJson(root, ['show', 'agent', 'worker']);
    for (const response of [human, json]) {
      expect(response.exitCode).toBe(0);
      const output = response.output.join('\n');
      expect(output).toContain('[REDACTED]');
      expect(output).not.toMatch(/authored-(?:agent|query|argv)-secret|authored-url-/u);
    }
  });

  it('inspects runs without creating or changing project-local store files', async () => {
    const root = await createFixtureProject();
    expect((await runJson(root, ['list', 'runs'])).exitCode).toBe(0);
    await expect(access(join(root, '.attest'))).rejects.toBeDefined();

    const storePath = join(root, '.attest', 'runs.db');
    await mkdir(join(root, '.attest'));
    const store = await openStore(storePath);
    const run = await store.runs.createRun({
      schemaId: 'attest.project',
      configHash: 'safe-hash',
      configJson: '{"secret":"must-not-render"}',
    });
    await store.close();
    const beforeBytes = await readFile(storePath);
    const beforeFiles = await readdir(join(root, '.attest'));

    const show = await runJson(root, ['show', 'run', run.id]);
    expect(show.exitCode).toBe(0);
    expect(show.output.join('')).not.toContain('must-not-render');
    expect(await readFile(storePath)).toEqual(beforeBytes);
    expect(await readdir(join(root, '.attest'))).toEqual(beforeFiles);
  });
});
