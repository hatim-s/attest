import { describe, expect, it } from 'vitest';
import {
  contextualRecents,
  readRecents,
  readTheme,
  rememberTarget,
  writeRecents,
  writeTheme,
  type PreferenceStorage,
} from '../preferences.js';
import { targetKey, type RecentTarget } from '../navigation.js';

const scope = { sourceId: 'local:workspace', projectKey: 'project', evalId: 'eval' };

const run = (runId: string): RecentTarget => ({ ...scope, kind: 'run', runId });

const memoryStorage = (): PreferenceStorage => {
  const values = new Map<string, string>();

  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
};

const blocked: PreferenceStorage = {
  getItem: () => {
    throw new Error('Blocked');
  },
  setItem: () => {
    throw new Error('Blocked');
  },
};

describe('recent navigation persistence', () => {
  it('keeps four newest identities, promotes revisits, and ignores tree pages', () => {
    let recents: RecentTarget[] = [];

    for (const id of ['1', '2', '3', '4', '5']) recents = rememberTarget(recents, run(id));
    expect(recents).toEqual(['5', '4', '3', '2'].map(run));
    recents = rememberTarget(recents, run('3'));
    expect(recents).toEqual(['3', '5', '4', '2'].map(run));
    expect(rememberTarget(recents, { ...scope, kind: 'runs' })).toEqual(recents);
    const storage = memoryStorage();
    writeRecents(storage, recents);
    expect(readRecents(storage)).toEqual(recents);
  });

  it('distinguishes sources, projects, evals, runs, and individual cases', () => {
    const first: RecentTarget = { ...scope, kind: 'run-case', runId: '1', caseId: 'a' };

    const targets: RecentTarget[] = [
      first,
      { ...first, sourceId: 'cloud' },
      { ...first, projectKey: 'other' },
      { ...first, evalId: 'other' },
      { ...first, runId: '2' },
      { ...first, caseId: 'b' },
    ];

    expect(new Set(targets.map(targetKey)).size).toBe(targets.length);
    expect(targetKey({ ...scope, kind: 'case', caseId: 'a:b' })).not.toBe(
      targetKey({ ...scope, evalId: 'eval:a', kind: 'case', caseId: 'b' }),
    );
  });

  it('filters to the current source and navigation context without counting the open page', () => {
    const own = run('1');
    const otherEval = { ...run('2'), evalId: 'other-eval' };
    const otherProject = { ...run('3'), projectKey: 'other-project' };
    const cloud = { ...run('4'), sourceId: 'cloud' };
    const recents = [own, otherEval, otherProject, cloud];
    expect(contextualRecents(recents, { ...scope, kind: 'projects' })).toEqual([
      own,
      otherEval,
      otherProject,
    ]);
    expect(contextualRecents(recents, { ...scope, kind: 'project' })).toEqual([own, otherEval]);
    expect(contextualRecents(recents, { ...scope, kind: 'cases' })).toEqual([own]);
    expect(contextualRecents(recents, own)).toEqual([]);
  });

  it('never writes runtime payloads, labels, URLs or extra fields', () => {
    const storage = memoryStorage();
    const supplied = { ...run('1'), payload: 'secret', label: 'private', href: 'https://private' };
    writeRecents(storage, [supplied]);
    expect(storage.getItem('attest-recents')).toBe(JSON.stringify([run('1')]));
  });

  it('rejects malformed, oversized, extra-field and unbounded stored data', () => {
    const storage = memoryStorage();

    for (const invalid of [
      '{',
      'null',
      '{}',
      JSON.stringify([{ ...run('1'), token: 'secret' }]),
      JSON.stringify([run('1'), run('2'), run('3'), run('4'), run('5')]),
      ' '.repeat(8193),
    ]) {
      storage.setItem('attest-recents', invalid);
      expect(readRecents(storage)).toEqual([]);
    }

    storage.setItem('attest-recents', JSON.stringify([run('1'), run('1')]));
    expect(readRecents(storage)).toEqual([run('1')]);
  });

  it('survives unavailable and blocked storage', () => {
    for (const storage of [undefined, blocked]) {
      expect(readRecents(storage)).toEqual([]);
      expect(() => writeRecents(storage, [run('1')])).not.toThrow();
    }
  });
});

describe('theme preference', () => {
  it('round trips system, light and dark and rejects invalid saved modes', () => {
    const storage = memoryStorage();

    for (const mode of ['system', 'light', 'dark'] as const) {
      writeTheme(storage, mode);
      expect(readTheme(storage)).toBe(mode);
    }

    storage.setItem('attest-theme', 'sepia');
    expect(readTheme(storage)).toBe('system');
  });

  it('follows the system when storage is unavailable', () => {
    for (const storage of [undefined, blocked]) {
      expect(readTheme(storage)).toBe('system');
      expect(() => writeTheme(storage, 'dark')).not.toThrow();
    }
  });
});
