import { describe, expect, it } from 'vitest';

import {
  portableProjectBundleSchema,
  type PortableProjectBundle,
} from '../cloud/project-bundle.js';
import { compileGeneratedSchema } from './support/compile-generated-schema.js';

const emptyBundle = {
  schema: 'attest.project-bundle.v1',
  resources: {
    project: {
      schema: 'attest.project',
      project_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      name: 'Portable',
      resources: { agents: [], tests: [], datasets: [], metrics: [] },
    },
    agents: [],
    tests: [],
    datasets: [],
    metrics: [],
  },
  files: {},
} satisfies PortableProjectBundle;

const filesOf = (count: number, value: string) =>
  Object.fromEntries(
    Array.from({ length: count }, (_, index) => [`attest/metrics/code/file-${index}.ts`, value]),
  );

describe('portable bundle limits and credentials', () => {
  it('agrees with generated schema on the file count boundary', () => {
    const validate = compileGeneratedSchema('project-bundle.json');

    for (const [count, valid] of [
      [100, true],
      [101, false],
    ] as const) {
      const candidate = { ...emptyBundle, files: filesOf(count, '') };
      expect(portableProjectBundleSchema.safeParse(candidate).success).toBe(valid);
      expect(validate(candidate)).toBe(valid);
    }
  });

  it.each([
    [
      'UTF-8 per-file overflow',
      filesOf(1, 'é'.repeat(524_289)),
      ['files', 'attest/metrics/code/file-0.ts'],
      'must be UTF-8 text without NUL bytes and at most 1 MiB',
    ],
    [
      'NUL bytes',
      filesOf(1, '\0'),
      ['files', 'attest/metrics/code/file-0.ts'],
      'must be UTF-8 text without NUL bytes and at most 1 MiB',
    ],
    [
      'decoded total overflow',
      filesOf(6, 'a'.repeat(900_000)),
      ['files'],
      'bundle files must total at most 5 MiB',
    ],
  ])('keeps %s as a runtime-only check', (_name, files, path, message) => {
    const candidate = { ...emptyBundle, files };
    const result = portableProjectBundleSchema.safeParse(candidate);
    expect(result.success).toBe(false);

    if (!result.success)
      expect(result.error.issues).toContainEqual(expect.objectContaining({ path, message }));
    expect(compileGeneratedSchema('project-bundle.json')(candidate)).toBe(true);
  });

  it('leaves serialized escaping limits to the upload request owner', () => {
    expect(
      portableProjectBundleSchema.safeParse({
        ...emptyBundle,
        files: filesOf(5, '\n'.repeat(600_000)),
      }).success,
    ).toBe(true);
  });

  it('accepts exactly 1 MiB of multibyte file text', () => {
    expect(
      portableProjectBundleSchema.safeParse({
        ...emptyBundle,
        files: filesOf(1, 'é'.repeat(524_288)),
      }).success,
    ).toBe(true);
  });
});
