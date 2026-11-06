import { parseWithSchema } from '@attest/contracts';
import { z } from 'zod';
import {
  recentTargetSchema,
  targetKey,
  type RecentTarget,
  type ShellTarget,
} from './navigation.js';

const RECENTS_KEY = 'attest-recents';

const THEME_KEY = 'attest-theme';

const RECENT_LIMIT = 4;

const themeSchema = z.enum(['system', 'light', 'dark']);

const recentsSchema = z.array(recentTargetSchema).max(RECENT_LIMIT);

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

    if (!raw || raw.length > 8192) return [];
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
  const scope = { sourceId: target.sourceId, projectKey: target.projectKey, evalId: target.evalId };

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
  if (target.kind !== 'run' && target.kind !== 'case' && target.kind !== 'run-case')
    return [...recents];
  const next = recentIdentity(target);

  return [next, ...recents.filter((item) => targetKey(item) !== targetKey(next))].slice(
    0,
    RECENT_LIMIT,
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
      JSON.stringify(recents.slice(0, RECENT_LIMIT).map(recentIdentity)),
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
  recents
    .filter(
      (item) =>
        item.sourceId === current.sourceId &&
        (current.kind === 'projects' || item.projectKey === current.projectKey) &&
        (current.kind === 'projects' ||
          current.kind === 'project' ||
          item.evalId === current.evalId) &&
        targetKey(item) !== targetKey(current),
    )
    .slice(0, RECENT_LIMIT);

export {
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
