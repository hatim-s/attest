import { parseWithSchema } from '@attest/contracts';
import { z } from 'zod';
import {
  recentTargetSchema,
  targetKey,
  type RecentTarget,
  type RecentLabel,
  type ShellTarget,
} from './navigation.js';

const RECENTS_KEY = 'attest-recents';

const THEME_KEY = 'attest-theme';

const RECENT_STORAGE_LIMIT = 20;

const RECENT_DISPLAY_LIMIT = 4;

// Five 256-character identities may each serialize as six-character JSON escapes.
const RECENT_BYTE_LIMIT = RECENT_STORAGE_LIMIT * (5 * 256 * 6 + 128);

const themeSchema = z.enum(['system', 'light', 'dark']);

const recentsSchema = z.array(recentTargetSchema).max(RECENT_STORAGE_LIMIT);

type ThemeMode = z.infer<typeof themeSchema>;

type PreferenceStorage = Pick<Storage, 'getItem' | 'setItem'>;

/** Storage can be denied even when the browser exposes the property. */
const browserStorage = (): PreferenceStorage | undefined => {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
};

/** Invalid or inaccessible preferences fall back to the operating system. */
const readTheme = (storage: PreferenceStorage | undefined): ThemeMode => {
  try {
    const parsed = parseWithSchema(themeSchema, storage?.getItem(THEME_KEY));

    return parsed.ok ? parsed.value : 'system';
  } catch {
    return 'system';
  }
};

/** Explicit system mode is persisted too, so all three choices survive reload. */
const writeTheme = (storage: PreferenceStorage | undefined, mode: ThemeMode): void => {
  try {
    storage?.setItem(THEME_KEY, mode);
  } catch {
    // A blocked store must not prevent an in-memory theme change.
  }
};

/** Only strict identity records cross the storage boundary; labels and payloads never do. */
const readRecents = (storage: PreferenceStorage | undefined): RecentTarget[] => {
  try {
    const raw = storage?.getItem(RECENTS_KEY);

    if (!raw || raw.length > RECENT_BYTE_LIMIT) return [];
    const candidate: unknown = JSON.parse(raw);
    const parsed = parseWithSchema(recentsSchema, candidate);

    return parsed.ok
      ? parsed.value.filter(
          (item, index, all) =>
            all.findIndex((other) => targetKey(other) === targetKey(item)) === index,
        )
      : [];
  } catch {
    return [];
  }
};

/** Reconstruct records instead of serializing caller objects that may carry extra fields. */
const recentIdentity = (target: RecentTarget): RecentTarget => {
  const projectScope = { sourceId: target.sourceId, projectKey: target.projectKey };

  if (target.kind === 'project-run')
    return { ...projectScope, kind: target.kind, runId: target.runId };

  if (target.kind === 'project-run-case')
    return { ...projectScope, kind: target.kind, runId: target.runId, caseId: target.caseId };
  const scope = { ...projectScope, evalId: target.evalId };

  switch (target.kind) {
    case 'run':
      return { ...scope, kind: target.kind, runId: target.runId };
    case 'case':
      return { ...scope, kind: target.kind, caseId: target.caseId };
    case 'run-case':
      return { ...scope, kind: target.kind, runId: target.runId, caseId: target.caseId };
  }
};

/** Deep pages only, newest first, deduplicated across their full scoped identity. */
const rememberTarget = (recents: readonly RecentTarget[], target: ShellTarget): RecentTarget[] => {
  if (!('runId' in target) && target.kind !== 'case') return [...recents];
  const parsed = parseWithSchema(recentTargetSchema, recentIdentity(target));

  if (!parsed.ok) return [...recents];
  const next = parsed.value;

  return [next, ...recents.filter((item) => targetKey(item) !== targetKey(next))].slice(
    0,
    RECENT_STORAGE_LIMIT,
  );
};

/** Persist only bounded navigation identities and tolerate quota or privacy restrictions. */
const writeRecents = (
  storage: PreferenceStorage | undefined,
  recents: readonly RecentTarget[],
): void => {
  try {
    storage?.setItem(
      RECENTS_KEY,
      JSON.stringify(
        recents
          .flatMap((target) => {
            const parsed = parseWithSchema(recentTargetSchema, recentIdentity(target));

            return parsed.ok ? [parsed.value] : [];
          })
          .filter(
            (item, index, all) =>
              all.findIndex((other) => targetKey(other) === targetKey(item)) === index,
          )
          .slice(0, RECENT_STORAGE_LIMIT),
      ),
    );
  } catch {
    // Recents remain usable for this session when persistence is unavailable.
  }
};

/** Keep the current source and optional project/eval context, excluding the open page. */
const contextualRecents = (
  recents: readonly RecentTarget[],
  current: ShellTarget,
): RecentTarget[] =>
  recents.filter(
    (item) =>
      item.sourceId === current.sourceId &&
      (current.kind === 'projects' || item.projectKey === current.projectKey) &&
      (current.kind === 'projects' ||
        current.kind === 'project' ||
        current.kind === 'project-runs' ||
        !('evalId' in current) ||
        ('evalId' in item && item.evalId === current.evalId)) &&
      targetKey(item) !== targetKey(current),
  );

/** Resolve availability before limiting rows so stale entries cannot hide useful history. */
const visibleRecents = (
  recents: readonly RecentTarget[],
  resolve: (target: RecentTarget) => RecentLabel | undefined,
) =>
  recents
    .flatMap((target) => {
      const text = resolve(target);

      return text ? [{ target, text }] : [];
    })
    .slice(0, RECENT_DISPLAY_LIMIT);

export {
  visibleRecents,
  browserStorage,
  readTheme,
  writeTheme,
  readRecents,
  writeRecents,
  rememberTarget,
  contextualRecents,
  type ThemeMode,
  type PreferenceStorage,
};
