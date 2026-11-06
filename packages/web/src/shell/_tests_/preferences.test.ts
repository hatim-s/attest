import { describe, expect, it } from 'vitest';
import {
  recordRecent,
  contextualRecents,
  visibleRecents,
  readRecents,
  readTheme,
  writeTheme,
  type PreferenceStorage,
} from '../preferences.js';
import { targetKey, type RecentTarget } from '../navigation.js';

const scope = { sourceId: 'local:workspace', projectKey: 'project', evalId: 'eval' };

const run = (runId: string) => ({ ...scope, kind: 'run' as const, runId });

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
  it('keeps twenty newest identities, promotes revisits, and ignores tree pages', () => {
    const storage = memoryStorage();
    let recents: RecentTarget[] = [];

    for (const id of ['1', '2', '3', '4', '5']) recents = recordRecent(storage, recents, run(id));
    expect(recents).toEqual(['5', '4', '3', '2', '1'].map(run));
    recents = recordRecent(storage, recents, run('3'));
    expect(recents).toEqual(['3', '5', '4', '2', '1'].map(run));
    expect(recordRecent(storage, recents, { ...scope, kind: 'runs' })).toEqual(recents);
    expect(readRecents(storage)).toEqual(recents);
  });

  it('merges visits recorded by a stale tab and keeps history with blocked storage', () => {
    const storage = memoryStorage();
    const stale = recordRecent(storage, [], run('a'));
    recordRecent(storage, stale, run('b'));
    const merged = recordRecent(storage, stale, run('c'));
    expect(merged).toEqual(['c', 'b', 'a'].map(run));
    expect(readRecents(storage)).toEqual(merged);
    expect(recordRecent(blocked, merged, run('d'))).toEqual(['d', 'c', 'b', 'a'].map(run));
  });

  it('isolates malformed entries and retains twenty unique valid identities in order', () => {
    const storage = memoryStorage();
    storage.setItem(
      'attest-recents',
      JSON.stringify([
        null,
        run('a'),
        { ...run('bad'), secret: 'private' },
        run('a'),
        ...Array.from({ length: 25 }, (_, i) => run(String(i))),
      ]),
    );
    expect(readRecents(storage)).toEqual([
      run('a'),
      ...Array.from({ length: 19 }, (_, i) => run(String(i))),
    ]);
  });

  it('keeps two suites with case-1 distinct inside the same project-wide run', () => {
    const first: RecentTarget = {
      ...scope,
      kind: 'project-run-case',
      runId: 'multi',
      caseId: 'case-1',
    };

    const second: RecentTarget = { ...first, evalId: 'eval-two' };
    const storage = memoryStorage();
    const recents = recordRecent(storage, recordRecent(storage, [], first), second);
    expect(readRecents(storage)).toEqual([second, first]);
    expect(targetKey(first)).not.toBe(targetKey(second));
    expect(contextualRecents(recents, first)).toEqual([second]);
    expect(contextualRecents(recents, { ...scope, kind: 'runs' })).toEqual([]);

    // Resolution receives the real suite and case pair.
    const cases = new Map([
      [
        JSON.stringify([first.evalId, first.caseId]),
        { label: 'First case', context: 'First eval' },
      ],
      [
        JSON.stringify([second.evalId, second.caseId]),
        { label: 'Second case', context: 'Second eval' },
      ],
    ]);

    const rows = visibleRecents(readRecents(storage), (target) =>
      'evalId' in target && 'caseId' in target
        ? cases.get(JSON.stringify([target.evalId, target.caseId]))
        : undefined,
    );

    expect(rows.map(({ text }) => text.label)).toEqual(['Second case', 'First case']);
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
    recordRecent(storage, [], supplied);
    expect(storage.getItem('attest-recents')).toBe(JSON.stringify([run('1')]));
  });

  it('rejects malformed, oversized, extra-field and unbounded stored data', () => {
    const storage = memoryStorage();

    for (const invalid of [
      '{',
      'null',
      '{}',
      JSON.stringify([{ ...run('1'), token: 'secret' }]),
      JSON.stringify(Array.from({ length: 101 }, (_, i) => run(String(i)))),
      JSON.stringify([run('1')]) + ' '.repeat(160000),
    ]) {
      storage.setItem('attest-recents', invalid);
      expect(readRecents(storage)).toEqual([]);
    }

    storage.setItem('attest-recents', JSON.stringify([run('1'), run('1')]));
    expect(readRecents(storage)).toEqual([run('1')]);
  });

  it('ignores invalid new identities and preserves valid prior history at the write boundary', () => {
    const storage = memoryStorage();
    const prior = [run('valid')];
    storage.setItem('attest-recents', JSON.stringify(prior));

    for (const id of ['', '   ', 'x'.repeat(257)]) {
      for (const target of [
        run(id),
        { ...run('1'), sourceId: id },
        { ...run('1'), projectKey: id },
        { ...run('1'), evalId: id },
        { ...scope, kind: 'case' as const, caseId: id },
        { ...scope, kind: 'run-case' as const, runId: '1', caseId: id },
      ]) {
        expect(recordRecent(storage, prior, target)).toEqual(prior);
        expect(readRecents(storage)).toEqual(prior);
      }
    }

    const mixed = [run(''), run('good'), run('  '), run('x'.repeat(257)), ...prior];
    let session: RecentTarget[] = prior;

    for (const target of [...mixed].reverse()) session = recordRecent(storage, session, target);
    expect(readRecents(storage)).toEqual([run('good'), ...prior]);
  });

  it('round trips the storage cap with worst-case escaped identities', () => {
    const escaped = '\u0001'.repeat(256);

    const targets = Array.from({ length: 20 }, (_, i): RecentTarget => ({
      kind: 'run-case',
      sourceId: escaped,
      projectKey: escaped,
      evalId: escaped,
      runId: escaped,
      caseId: String(i) + escaped.slice(String(i).length),
    }));

    const storage = memoryStorage();
    let recents: RecentTarget[] = [];

    for (const target of [...targets].reverse()) recents = recordRecent(storage, recents, target);
    expect(readRecents(storage)).toEqual(targets);
    expect(recordRecent(storage, recents, run('new'))).toHaveLength(20);
  });

  it('retains older context history and isolates project-wide from eval-scoped identities', () => {
    const projectRun: RecentTarget = {
      kind: 'project-run',
      sourceId: scope.sourceId,
      projectKey: scope.projectKey,
      runId: '1',
    };

    let recents: RecentTarget[] = [projectRun, run('old')];
    const storage = memoryStorage();
    storage.setItem('attest-recents', JSON.stringify(recents));

    for (let i = 0; i < 10; i++)
      recents = recordRecent(storage, recents, { ...run(String(i)), evalId: 'other' });
    expect(contextualRecents(readRecents(storage), { ...scope, kind: 'runs' })).toEqual([
      run('old'),
    ]);
    expect(
      contextualRecents(readRecents(storage), {
        kind: 'project-runs',
        sourceId: scope.sourceId,
        projectKey: scope.projectKey,
      }),
    ).toHaveLength(12);
    expect(targetKey(projectRun)).not.toBe(targetKey(run('1')));
  });

  it('caps display only after filtering context and resolving unavailable targets', () => {
    const recents = [
      ...Array.from({ length: 5 }, (_, i) => ({ ...run(String(i)), sourceId: 'other' })),
      ...['missing1', 'missing2', 'a', 'b', 'c', 'd', 'e'].map(run),
    ];

    const visible = visibleRecents(
      contextualRecents(recents, { ...scope, kind: 'runs' }),
      (target) =>
        'runId' in target && !target.runId.startsWith('missing')
          ? { label: target.runId, context: 'eval' }
          : undefined,
    );

    expect(visible.map(({ target }) => target)).toEqual(['a', 'b', 'c', 'd'].map(run));
  });

  it('survives unavailable and blocked storage', () => {
    for (const storage of [undefined, blocked]) {
      expect(readRecents(storage)).toEqual([]);
      expect(recordRecent(storage, [], run('1'))).toEqual([run('1')]);
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
