import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadProject } from '../load-project.js';
import { prepareProjectCandidate } from './candidate-project.js';
import {
  candidateFromLoadedProject,
  writeFixtureProject,
} from './project-transaction.test-fixture.js';
import { createSemanticProjectDiff } from './semantic-project-diff.js';

const temporaryDirectories: string[] = [];

/** Creates one isolated valid project for semantic transaction tests. */
const createProject = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'attest-semantic-diff-'));
  temporaryDirectories.push(root);
  await writeFixtureProject(root);
  return root;
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe('semantic project candidates', () => {
  it('rebuilds canonical manifest hashes and deterministic file bytes', async () => {
    const root = await createProject();
    const loaded = await loadProject({ project: root });
    const candidate = candidateFromLoadedProject(loaded);
    candidate.tests[0]!.name = 'Updated refund';

    const first = prepareProjectCandidate(candidate);
    const second = prepareProjectCandidate(structuredClone(candidate));

    expect(first.projectHash).toBe(second.projectHash);
    expect(first.files.get('attest/tests/refund.json')?.contents).toBe(
      second.files.get('attest/tests/refund.json')?.contents,
    );
    expect(first.files.get('attest/tests/refund.json')?.contents).toMatch(/^\{\n  "agent_id"/u);
    expect(first.files.get('attest/tests/refund.json')?.contents.endsWith('\n')).toBe(true);
    expect(first.project.project.resources.tests[0]?.content_hash).toBe(
      first.files.get('attest/tests/refund.json')?.canonicalHash,
    );
  });

  it('reports field changes and reference detachments without authored values', async () => {
    const root = await createProject();
    const loaded = await loadProject({ project: root });
    const candidate = candidateFromLoadedProject(loaded);
    candidate.tests[0]!.name = 'Sensitive authored value';
    candidate.tests[0]!.datasets = [];
    candidate.datasets = [];
    const prepared = prepareProjectCandidate(candidate);

    const diff = createSemanticProjectDiff(loaded, prepared.project);
    const rendered = JSON.stringify(diff);

    expect(diff.operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ op: 'remove', resource: { id: 'refunds', type: 'dataset' } }),
        expect.objectContaining({ op: 'update', resource: { id: 'refund', type: 'test' } }),
        expect.objectContaining({ op: 'detach', resource: { id: 'refunds', type: 'dataset' } }),
      ]),
    );
    expect(rendered).toContain('/name');
    expect(rendered).not.toContain('Sensitive authored value');
  });
});
