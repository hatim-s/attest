import { describe, expect, it } from 'vitest';
import {
  PROJECT_SCHEMA_ID,
  AGENT_RESOURCE_SCHEMA_ID,
  TEST_RESOURCE_SCHEMA_ID,
  COMMAND_REQUEST_SCHEMA_ID,
  type PortableProjectBundle,
} from '@attest/contracts';
import { contentHash } from '../../store/internal/canonical-json.js';
import { resolvePortableProject } from '../portable-project.js';
import { resolveEvalRun } from '../eval-resolver.js';

/** Builds a canonical HTTP project with the same authored hashes used by the local loader. */
const bundle = (): PortableProjectBundle => {
  const agent = {
    schema: AGENT_RESOURCE_SCHEMA_ID,
    id: 'agent',
    name: 'Agent',
    transport: {
      kind: 'http' as const,
      lifecycle: 'external' as const,
      response_mode: 'mapped' as const,
      request: { url: 'https://example.com/run', method: 'POST' as const },
      extraction: { result_pointer: '/result' },
    },
  };
  const test = {
    schema: TEST_RESOURCE_SCHEMA_ID,
    id: 'test',
    name: 'Test',
    agent_id: 'agent',
    metrics: [],
    datasets: [],
    cases: [{ id: 'one', input: { prompt: 'hello' } }],
  };
  const project = {
    schema: PROJECT_SCHEMA_ID,
    project_id: '01ARZ3NDEKTSV4RRFFQ69G5FAB',
    name: 'Portable',
    resources: {
      agents: [
        {
          id: agent.id,
          schema: agent.schema,
          path: 'attest/agents/agent.json',
          content_hash: contentHash(agent),
        },
      ],
      tests: [
        {
          id: test.id,
          schema: test.schema,
          path: 'attest/tests/test.json',
          content_hash: contentHash(test),
        },
      ],
      datasets: [],
      metrics: [],
    },
  };
  return {
    schema: 'attest.project-bundle.v1',
    resources: { project, agents: [agent], tests: [test], datasets: [], metrics: [] },
    files: {
      'attest.project.json': JSON.stringify(project),
      'attest/agents/agent.json': JSON.stringify(agent),
      'attest/tests/test.json': JSON.stringify(test),
    },
  };
};

describe('portable project resolution', () => {
  it('resolves the existing authored cases and snapshot without local paths', () => {
    const project = resolvePortableProject(bundle());
    const run = resolveEvalRun(
      project,
      { schema: COMMAND_REQUEST_SCHEMA_ID, command: 'eval.run', all: true, output: 'json' },
      { argv: ['attest', 'cloud', 'run'] },
    );
    expect(run.cases.map(({ case_id }) => case_id)).toEqual(['one']);
    expect(run.snapshot.project_hash).toBe(project.projectHash);
  });
  it('rejects resource/source and declared hash mismatches', () => {
    const input = bundle();
    input.files['attest/tests/test.json'] = '{}';
    expect(() => resolvePortableProject(input)).toThrow('differs');
    const changed = bundle();
    changed.resources.project.resources.agents[0]!.content_hash = '0'.repeat(64);
    changed.files['attest.project.json'] = JSON.stringify(changed.resources.project);
    expect(() => resolvePortableProject(changed)).toThrow('differs');
  });
  it.each([
    '../secret',
    'attest/../secret.json',
    'attest/.env',
    'attest/metrics/code/../../x.ts',
    'attest/agents/unreferenced.json',
  ])('rejects unsafe or unreferenced file %s', (path) => {
    const input = bundle();
    input.files[path] = 'secret';
    expect(() => resolvePortableProject(input)).toThrow();
  });
  it('rejects literal authorization before storing a revision', () => {
    const input = bundle();
    const agent = input.resources.agents[0]!;
    if (agent.transport.kind !== 'http') throw new Error('fixture');
    agent.transport.request.headers = { Authorization: 'Bearer secret' };
    input.resources.project.resources.agents[0]!.content_hash = contentHash(agent);
    input.files['attest/agents/agent.json'] = JSON.stringify(agent);
    input.files['attest.project.json'] = JSON.stringify(input.resources.project);
    expect(() => resolvePortableProject(input)).toThrow('secret reference');
  });
});

describe('portable metric dependencies', () => {
  it.each([
    ['helper.ts', "import './other.ts';"],
    ['helper.ts', "import x from 'npm-package';"],
    ['helper.py', 'import requests'],
    ['helper.py', 'from .helper import score'],
  ])('rejects unsupported dependencies in %s', (name, source) => {
    const input = bundle();
    input.files[`attest/metrics/code/${name}`] = source;
    expect(() => resolvePortableProject(input)).toThrow('self-contained');
  });
  it.each([
    ['helper.ts', "import { createHash } from 'node:crypto';"],
    ['helper.py', 'import json, math'],
  ])('allows built-ins in %s', (name, source) => {
    const input = bundle();
    input.files[`attest/metrics/code/${name}`] = source;
    expect(() => resolvePortableProject(input)).not.toThrow();
  });
});
