import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { METRIC_PRESETS, findMetricPreset, metricPresetSchema } from './metric-presets.js';

const FIXTURE_DIRECTORY = resolve(import.meta.dirname, 'fixtures/metric-presets');

describe('versioned metric presets', () => {
  it('matches one strict golden fixture per stable preset id', async () => {
    const fixtureNames = (await readdir(FIXTURE_DIRECTORY)).sort();
    const fixtures = await Promise.all(
      fixtureNames.map(async (fixtureName) =>
        metricPresetSchema.parse(
          JSON.parse(await readFile(resolve(FIXTURE_DIRECTORY, fixtureName), 'utf8')) as unknown,
        ),
      ),
    );

    expect(fixtureNames).toEqual(METRIC_PRESETS.map(({ id }) => `${id}.json`).sort());
    expect(fixtures).toEqual(
      [...METRIC_PRESETS].sort(({ id: left }, { id: right }) => left.localeCompare(right)),
    );
  });

  it('rejects unknown preset fields and duplicate hidden alternatives', () => {
    expect(
      metricPresetSchema.safeParse({ ...METRIC_PRESETS[0], hidden_prompt: 'not inspectable' })
        .success,
    ).toBe(false);
  });

  it('keeps catalog arrays, definitions, and lookup results deeply immutable', () => {
    const preset = findMetricPreset('output-equals');
    expect(Object.isFrozen(METRIC_PRESETS)).toBe(true);
    expect(Object.isFrozen(preset)).toBe(true);
    expect(Object.isFrozen(preset.definition)).toBe(true);
    expect(Reflect.set(preset, 'name', 'tampered')).toBe(false);
    expect(Reflect.set(preset.definition, 'kind', 'http')).toBe(false);
    expect(findMetricPreset('output-equals').name).toBe('Output equals');
  });
});
