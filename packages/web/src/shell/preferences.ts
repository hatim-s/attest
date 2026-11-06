import { parseWithSchema } from '@attest/contracts';
import { z } from 'zod';
import {
  recentTargetSchema,
  isProjectWide,
  isRecordableTarget,
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

const recentsSchema = z.array(z.unknown()).max(100);

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

    return parsed.ok ? validatedRecents(parsed.value) : [];
  } catch {
    return [];
  }
};

/** Reconstruct records instead of serializing caller objects that may carry extra fields. */
const recentIdentity = (target: RecentTarget): RecentTarget => {
  const projectScope = { sourceId: target.sourceId, projectKey: target.projectKey };

  if (target.kind === 'project-run')
    return { ...projectScope, kind: target.kind, runId: target.runId };

  const scope = { ...projectScope, evalId: target.evalId };

  switch (target.kind) {
    case 'run':
      return { ...scope, kind: target.kind, runId: target.runId };
    case 'case':
      return { ...scope, kind: target.kind, caseId: target.caseId };
    case 'project-run-case':
    case 'run-case':
      return { ...scope, kind: target.kind, runId: target.runId, caseId: target.caseId };
  }
};

/** Validate each untrusted entry independently, then deduplicate and cap the valid history. */
const validatedRecents = (candidates: readonly unknown[]): RecentTarget[] => {
  const result: RecentTarget[] = [];
  const seen = new Set<string>();

  for (const candidate of candidates) {
    const parsed = parseWithSchema(recentTargetSchema, candidate);

    if (!parsed.ok) continue;
    const target = parsed.value;
    const key = targetKey(target);

    if (seen.has(key)) continue;
    seen.add(key);
    result.push(target);

    if (result.length === RECENT_STORAGE_LIMIT) break;
  }

  return result;
};

/** Check new route identities once before they enter validated history. */
const recordableIdentity = (target: ShellTarget): RecentTarget | undefined => {
  if (!isRecordableTarget(target)) return undefined;
  const parsed = parseWithSchema(recentTargetSchema, recentIdentity(target));

  return parsed.ok ? parsed.value : undefined;
};

/** First occurrence wins, preserving newest storage visits before older session history. */
const mergeRecents = (...groups: readonly (readonly RecentTarget[])[]): RecentTarget[] => {
  const entries = new Map<string, RecentTarget>();

  for (const group of groups) {
    for (const target of group) {
      const key = targetKey(target);

      if (!entries.has(key)) entries.set(key, target);
    }
  }

  return [...entries.values()].slice(0, RECENT_STORAGE_LIMIT);
};

/** Persistence failure leaves the caller's session history intact. */
const persistRecents = (
  storage: PreferenceStorage | undefined,
  recents: readonly RecentTarget[],
) => {
  try {
    storage?.setItem(RECENTS_KEY, JSON.stringify(recents));
  } catch {
    // Privacy restrictions and quota failures must not discard session history.
  }
};

/** Refresh shared history immediately before recording, outside React state updaters. */
const recordRecent = (
  storage: PreferenceStorage | undefined,
  session: readonly RecentTarget[],
  target: ShellTarget,
): RecentTarget[] => {
  const identity = recordableIdentity(target);

  if (!identity) return [...session];
  const next = mergeRecents([identity], readRecents(storage), session);
  persistRecents(storage, next);

  return next;
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
      (isProjectWide(current) ||
        ('evalId' in current &&
          !isProjectWide(item) &&
          'evalId' in item &&
          item.evalId === current.evalId)) &&
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
  recordRecent,
  visibleRecents,
  browserStorage,
  readTheme,
  writeTheme,
  readRecents,
  contextualRecents,
  type ThemeMode,
  type PreferenceStorage,
};
